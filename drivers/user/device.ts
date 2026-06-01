import Homey from 'homey';
import type HomeyfinApp from '../../app';
import { ClientSnapshot, ServerHub } from '../../lib/ServerHub';
import type { NowPlayingItem } from '../../lib/JellyfinClient';

interface UserStore {
  serverId: string;
  userId: string;
  userName: string;
}

interface UserSettings {
  stoppedDebounceMs?: number;
  unwatchedRefreshMinutes?: number;
}

const POSITION_TICK_MS = 1000;

export default class JellyfinUserDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private store!: UserStore;
  private positionTimer?: NodeJS.Timeout;
  private stoppedDebounceTimer?: NodeJS.Timeout;
  private pendingStop?: { snap: ClientSnapshot; item: NowPlayingItem | undefined };
  private unwatchedTimer?: NodeJS.Timeout;
  private albumArtImage?: Homey.Image;
  private posterTokenImage?: Homey.Image;
  private lastArtworkUrl = '';
  private firedProgressMilestones = new Set<number>();
  private firedRemainingMilestones = new Set<number>();
  private trackedItemId?: string;

  async onInit(): Promise<void> {
    this.store = this.getStore() as UserStore;
    const app = this.homey.app as HomeyfinApp;

    this.hub = app.getHub(this.store.serverId);
    if (!this.hub) {
      this.setUnavailable('Jellyfin server not connected yet').catch(() => undefined);
      this.homey.setTimeout(() => this.onInit().catch((e) => this.error(e)), 5_000);
      return;
    }

    await this.setupAlbumArt().catch((err) =>
      this.error('setupAlbumArt failed', (err as Error).message),
    );
    this.registerCapabilityHandlers();
    this.registerHubHandlers();
    this.registerFlowHandlers();
    this.startPositionTicker();
    this.startUnwatchedRefresh();

    const snap = this.hub.getUserSnapshot(this.store.userId);
    if (snap) await this.applySnapshot(snap);
    else await this.safeSet('client_online', false);
    await this.refreshUserData().catch(() => undefined);

    this.setAvailable().catch(() => undefined);
  }

  async onDeleted(): Promise<void> {
    this.teardown();
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    if (changedKeys.includes('unwatchedRefreshMinutes')) {
      this.startUnwatchedRefresh();
    }
  }

  private teardown(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
    [this.positionTimer, this.stoppedDebounceTimer, this.unwatchedTimer].forEach((t) => {
      if (t) clearTimeout(t);
    });
    if (this.positionTimer) clearInterval(this.positionTimer);
    if (this.unwatchedTimer) clearInterval(this.unwatchedTimer);
    this.positionTimer = undefined;
    this.unwatchedTimer = undefined;
    this.stoppedDebounceTimer = undefined;
  }

  private async setupAlbumArt(): Promise<void> {
    const makeImage = async (urlGetter: () => string) => {
      const img = await this.homey.images.createImage();
      (img as any).setStream(async (stream: NodeJS.WritableStream) => {
        const url = urlGetter();
        if (!url) {
          stream.end();
          return;
        }
        try {
          const res = await fetch(url);
          if (!res.ok || !res.body) {
            stream.end();
            return;
          }
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            stream.write(chunk);
          }
          stream.end();
        } catch {
          stream.end();
        }
      });
      return img;
    };

    this.albumArtImage = await makeImage(() => this.lastArtworkUrl);
    this.posterTokenImage = await makeImage(() => this.lastArtworkUrl);
    await this.setAlbumArtImage(this.albumArtImage).catch(() => undefined);
  }

  // --- Background refresh: unwatched + continue watching ----------------

  private startUnwatchedRefresh(): void {
    if (this.unwatchedTimer) clearInterval(this.unwatchedTimer);
    const settings = this.getSettings() as UserSettings;
    const minutes = Math.max(1, settings.unwatchedRefreshMinutes ?? 10);
    this.unwatchedTimer = setInterval(
      () => this.refreshUserData().catch(() => undefined),
      minutes * 60_000,
    );
  }

  private async refreshUserData(): Promise<void> {
    if (!this.hub) return;
    try {
      const unwatched = await this.hub.client.getUnplayedCount(this.store.userId, 'Episode');
      await this.safeSet('unwatched_count', unwatched);
    } catch (err) {
      this.error('refresh unwatched failed', (err as Error).message);
    }
    try {
      const resume = await this.hub.client.getResumeItems({
        userId: this.store.userId,
        limit: 1,
      });
      const item = resume.Items?.[0];
      if (item) {
        const label = item.SeriesName
          ? `${item.SeriesName} · S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              item.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${item.Name}`
          : item.Name;
        await this.safeSet('continue_watching_title', label);
      } else {
        await this.safeSet('continue_watching_title', '');
      }
    } catch (err) {
      this.error('refresh resume failed', (err as Error).message);
    }
  }

  // --- Position ticker + progress milestones ----------------------------

  private startPositionTicker(): void {
    if (this.positionTimer) return;
    this.positionTimer = setInterval(() => {
      const snap = this.hub?.getUserSnapshot(this.store.userId);
      if (!snap || !snap.online || snap.isPaused || !snap.nowPlaying) return;
      const current = (this.getCapabilityValue('media_position') as number | null) ?? 0;
      const duration = snap.durationSeconds ?? 0;
      const next = duration > 0 ? Math.min(current + 1, duration) : current + 1;
      this.safeSet('media_position', next).catch(() => undefined);
      this.checkProgressTriggers(snap, next, duration);
    }, POSITION_TICK_MS);
  }

  private checkProgressTriggers(snap: ClientSnapshot, position: number, duration: number): void {
    if (duration <= 0) return;
    if (snap.nowPlaying?.Id !== this.trackedItemId) {
      this.trackedItemId = snap.nowPlaying?.Id;
      this.firedProgressMilestones.clear();
      this.firedRemainingMilestones.clear();
    }

    const percent = Math.floor((position / duration) * 100);
    this.fireProgressIfNew(percent, snap);

    const remaining = Math.max(0, duration - position);
    const remainingMin = Math.floor(remaining / 60);
    this.fireRemainingIfNew(remainingMin, remaining, snap);
  }

  private fireProgressIfNew(percent: number, snap: ClientSnapshot): void {
    // Only the highest milestone reached is interesting; iterate all 1..99 and fire each at first crossing.
    if (percent < 1 || percent > 99) return;
    if (this.firedProgressMilestones.has(percent)) return;
    this.firedProgressMilestones.add(percent);
    const item = snap.nowPlaying;
    if (!item) return;
    this.homey.flow
      .getDeviceTriggerCard('progress_percent')
      .trigger(
        this,
        { title: item.Name ?? '', type: item.Type ?? '' },
        { percent },
      )
      .catch((err: Error) => this.error('progress trigger failed', err.message));
  }

  private fireRemainingIfNew(remainingMin: number, remainingSeconds: number, snap: ClientSnapshot): void {
    if (remainingMin < 1 || remainingMin > 60) return;
    if (this.firedRemainingMilestones.has(remainingMin)) return;
    this.firedRemainingMilestones.add(remainingMin);
    const item = snap.nowPlaying;
    if (!item) return;
    this.homey.flow
      .getDeviceTriggerCard('minutes_before_end')
      .trigger(
        this,
        {
          title: item.Name ?? '',
          type: item.Type ?? '',
          series: item.SeriesName ?? '',
          remaining_seconds: remainingSeconds,
        },
        { minutes: remainingMin },
      )
      .catch((err: Error) => this.error('minutes_before_end trigger failed', err.message));
  }

  // --- Hub event wiring --------------------------------------------------

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const userId = this.store.userId;

    const onUpdate = (snap: ClientSnapshot) =>
      this.applySnapshot(snap).catch((e) => this.error(e));
    const onStarted = (snap: ClientSnapshot, item: NowPlayingItem) => {
      this.cancelPendingStop();
      this.fireMediaTrigger('playback_started', item, snap);
    };
    const onPaused = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_paused', item, snap);
    const onResumed = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_resumed', item, snap);
    const onStopped = (snap: ClientSnapshot, item: NowPlayingItem | undefined) =>
      this.scheduleStop(snap, item);
    const onChanged = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('now_playing_changed', item, snap);

    const ev = (suffix: string) => `user:${userId}:${suffix}`;
    this.hub.on(ev('update'), onUpdate);
    this.hub.on(ev('playback_started'), onStarted);
    this.hub.on(ev('playback_paused'), onPaused);
    this.hub.on(ev('playback_resumed'), onResumed);
    this.hub.on(ev('playback_stopped'), onStopped);
    this.hub.on(ev('now_playing_changed'), onChanged);

    this.offCallbacks.push(
      () => this.hub?.off(ev('update'), onUpdate),
      () => this.hub?.off(ev('playback_started'), onStarted),
      () => this.hub?.off(ev('playback_paused'), onPaused),
      () => this.hub?.off(ev('playback_resumed'), onResumed),
      () => this.hub?.off(ev('playback_stopped'), onStopped),
      () => this.hub?.off(ev('now_playing_changed'), onChanged),
    );
  }

  private scheduleStop(snap: ClientSnapshot, item: NowPlayingItem | undefined): void {
    const settings = this.getSettings() as UserSettings;
    const delay = Math.max(0, settings.stoppedDebounceMs ?? 4000);
    this.cancelPendingStop();
    this.pendingStop = { snap, item };
    if (delay === 0) {
      this.firePendingStop();
      return;
    }
    this.stoppedDebounceTimer = this.homey.setTimeout(() => this.firePendingStop(), delay);
  }

  private cancelPendingStop(): void {
    if (this.stoppedDebounceTimer) {
      clearTimeout(this.stoppedDebounceTimer);
      this.stoppedDebounceTimer = undefined;
    }
    this.pendingStop = undefined;
  }

  private firePendingStop(): void {
    if (!this.pendingStop) return;
    const { snap, item } = this.pendingStop;
    this.pendingStop = undefined;
    this.stoppedDebounceTimer = undefined;
    const current = this.hub?.getUserSnapshot(this.store.userId);
    if (current?.nowPlaying) return;
    if (item) this.fireMediaTrigger('playback_stopped', item, snap);
  }

  // --- Capability listeners (Homey → Jellyfin) ---------------------------

  private registerCapabilityHandlers(): void {
    this.registerCapabilityListener('speaker_playing', async (value: boolean) => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.sendPlaystate(sessionId, value ? 'Unpause' : 'Pause');
    });
    this.registerCapabilityListener('speaker_next', async () => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.sendPlaystate(sessionId, 'NextTrack');
    });
    this.registerCapabilityListener('speaker_prev', async () => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.sendPlaystate(sessionId, 'PreviousTrack');
    });
    this.registerCapabilityListener('volume_set', async (value: number) => {
      const sessionId = await this.requireSessionId();
      const volume = Math.round(Math.max(0, Math.min(1, value)) * 100);
      await this.hub!.client.sendCommand(sessionId, 'SetVolume', { Volume: volume });
    });
    this.registerCapabilityListener('volume_mute', async (value: boolean) => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.sendCommand(sessionId, value ? 'Mute' : 'Unmute');
    });
  }

  private async requireSessionId(): Promise<string> {
    const snap = this.hub?.getUserSnapshot(this.store.userId);
    if (!snap || !snap.online || !snap.sessionId) {
      throw new Error('User has no active Jellyfin session right now');
    }
    return snap.sessionId;
  }

  private currentSession(): { sessionId: string; snap: ClientSnapshot } | undefined {
    const snap = this.hub?.getUserSnapshot(this.store.userId);
    if (!snap || !snap.online || !snap.sessionId) return undefined;
    return { sessionId: snap.sessionId, snap };
  }

  // --- Flow registration -------------------------------------------------

  private registerFlowHandlers(): void {
    const userId = this.store.userId;

    this.homey.flow
      .getConditionCard('is_playing')
      .registerRunListener(async () => {
        const snap = this.hub?.getUserSnapshot(userId);
        return Boolean(snap?.nowPlaying && !snap.isPaused);
      });

    this.homey.flow
      .getConditionCard('media_type_is')
      .registerRunListener(async (args: { media_type: string }) => {
        const snap = this.hub?.getUserSnapshot(userId);
        return snap?.nowPlaying?.Type === args.media_type;
      });

    this.homey.flow
      .getConditionCard('is_transcoding')
      .registerRunListener(async () => {
        const snap = this.hub?.getUserSnapshot(userId);
        return Boolean(snap?.isTranscoding);
      });

    this.homey.flow
      .getActionCard('send_message')
      .registerRunListener(async (args: { header?: string; text: string; timeout_ms?: number }) => {
        const sessionId = await this.requireSessionId();
        await this.hub!.client.sendMessage(
          sessionId,
          args.header && args.header.length > 0 ? args.header : 'Homey',
          args.text ?? '',
          typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 5000,
        );
      });

    this.homey.flow.getActionCard('seek_to').registerRunListener(async (args: { seconds: number }) => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.seekToSeconds(sessionId, args.seconds);
    });

    this.homey.flow
      .getActionCard('seek_relative')
      .registerRunListener(async (args: { seconds: number }) => {
        const session = this.currentSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const current = session.snap.positionSeconds ?? 0;
        const duration = session.snap.durationSeconds ?? 0;
        const target = Math.max(
          0,
          duration > 0 ? Math.min(duration, current + (args.seconds || 0)) : current + args.seconds,
        );
        await this.hub!.client.seekToSeconds(session.sessionId, target);
      });

    const playItem = this.homey.flow.getActionCard('play_item');
    playItem.registerRunListener(async (args: { item: { id?: string; name?: string } }) => {
      const session = this.currentSession();
      if (!session) throw new Error('User has no active Jellyfin session right now');
      if (!args.item?.id) throw new Error('No item picked');
      await this.hub!.client.playItemsOnSession(session.sessionId, [args.item.id]);
    });
    playItem.registerArgumentAutocompleteListener('item', async (query) => {
      if (!this.hub || !query || query.length < 2) return [];
      const res = await this.hub.client
        .searchItems({
          userId,
          searchTerm: query,
          limit: 20,
          includeItemTypes: 'Movie,Episode,Series',
        })
        .catch(() => ({ Items: [] }));
      return res.Items.map((i) => ({
        name: i.SeriesName
          ? `${i.SeriesName} · S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(
              i.IndexNumber ?? 0,
            ).padStart(2, '0')} – ${i.Name}`
          : i.ProductionYear
            ? `${i.Name} (${i.ProductionYear})`
            : i.Name,
        id: i.Id,
      }));
    });

    this.homey.flow
      .getActionCard('play_random')
      .registerRunListener(async (args: { item_type: 'Movie' | 'Episode' }) => {
        const session = this.currentSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const res = await this.hub!.client.getRandomItems({
          userId,
          limit: 1,
          includeItemTypes: args.item_type,
        });
        const item = res.Items?.[0];
        if (!item) throw new Error('No item found for this type');
        await this.hub!.client.playItemsOnSession(session.sessionId, [item.Id]);
        return { title: item.Name };
      });

    this.homey.flow.getActionCard('continue_watching').registerRunListener(async () => {
      const session = this.currentSession();
      if (!session) throw new Error('User has no active Jellyfin session right now');
      const res = await this.hub!.client.getResumeItems({ userId, limit: 1 });
      const item = res.Items?.[0];
      if (!item) throw new Error('Nothing to continue');
      const startTicks = item.UserData ? undefined : undefined;
      await this.hub!.client.playItemsOnSession(session.sessionId, [item.Id], {
        startPositionTicks: startTicks,
      });
      return { title: item.Name };
    });

    const audioAction = this.homey.flow.getActionCard('set_audio_track');
    audioAction.registerRunListener(async (args: { track: { id?: string } }) => {
      const sessionId = await this.requireSessionId();
      const idx = Number(args.track?.id);
      if (!Number.isFinite(idx)) throw new Error('Pick a track');
      await this.hub!.client.sendCommand(sessionId, 'SetAudioStreamIndex', { Index: idx });
    });
    audioAction.registerArgumentAutocompleteListener('track', async () => this.listStreams('Audio'));

    const subAction = this.homey.flow.getActionCard('set_subtitle_track');
    subAction.registerRunListener(async (args: { track: { id?: string } }) => {
      const sessionId = await this.requireSessionId();
      const idx = Number(args.track?.id);
      await this.hub!.client.sendCommand(sessionId, 'SetSubtitleStreamIndex', { Index: idx });
    });
    subAction.registerArgumentAutocompleteListener('track', async () => {
      const items = await this.listStreams('Subtitle');
      return [{ name: 'Off', id: '-1' }, ...items];
    });

    this.homey.flow.getActionCard('mark_watched').registerRunListener(async () => {
      const snap = this.hub?.getUserSnapshot(userId);
      const id = snap?.nowPlaying?.Id;
      if (!id) throw new Error('Nothing is currently playing');
      await this.hub!.client.setPlayed(userId, id, true);
    });

    this.homey.flow.getActionCard('toggle_favorite').registerRunListener(async () => {
      const snap = this.hub?.getUserSnapshot(userId);
      const id = snap?.nowPlaying?.Id;
      if (!id) throw new Error('Nothing is currently playing');
      // Optimistic toggle — we don't track previous state, so use a probe + flip.
      const items = await this.hub!.client.searchItems({
        userId,
        searchTerm: snap!.nowPlaying!.Name,
        limit: 1,
      });
      const fav = items.Items?.[0]?.UserData?.IsFavorite === true;
      await this.hub!.client.setFavorite(userId, id, !fav);
    });
  }

  private listStreams(kind: 'Audio' | 'Subtitle'): Array<{ name: string; id: string }> {
    const snap = this.hub?.getUserSnapshot(this.store.userId);
    const streams = snap?.nowPlaying?.MediaStreams?.filter((s) => s.Type === kind) ?? [];
    return streams.map((s) => ({
      name: s.DisplayTitle ?? `${s.Language ?? '???'} (${s.Codec ?? ''})`.trim(),
      id: String(s.Index),
    }));
  }

  // --- Snapshot application ----------------------------------------------

  private async applySnapshot(snap: ClientSnapshot): Promise<void> {
    await this.safeSet('client_online', snap.online);
    await this.safeSet('is_transcoding', snap.isTranscoding);

    const playing = Boolean(snap.nowPlaying && !snap.isPaused);
    await this.safeSet('speaker_playing', playing);

    if (typeof snap.volumeLevel === 'number') {
      await this.safeSet('volume_set', Math.max(0, Math.min(1, snap.volumeLevel / 100)));
    }
    await this.safeSet('volume_mute', snap.isMuted);

    const item = snap.nowPlaying;
    if (item) {
      await this.safeSet('media_title', this.titleFor(item));
      await this.safeSet('media_subtitle', this.subtitleFor(item));
      await this.safeSet('speaker_track', item.Name ?? '');
      await this.safeSet('speaker_artist', item.SeriesName ?? item.Type ?? '');
      await this.safeSet(
        'speaker_album',
        item.SeasonName ?? (item.ProductionYear ? String(item.ProductionYear) : ''),
      );
    } else {
      await this.safeSet('media_title', '');
      await this.safeSet('media_subtitle', '');
      await this.safeSet('speaker_track', '');
      await this.safeSet('speaker_artist', '');
      await this.safeSet('speaker_album', '');
    }

    if (typeof snap.positionSeconds === 'number') {
      await this.safeSet('media_position', snap.positionSeconds);
    }
    await this.safeSet('media_duration', snap.durationSeconds ?? 0);

    await this.updateAlbumArt(snap.posterUrl ?? '');
  }

  private async updateAlbumArt(url: string): Promise<void> {
    if (url === this.lastArtworkUrl) return;
    this.lastArtworkUrl = url;
    try {
      if (this.albumArtImage) await this.albumArtImage.update();
      if (this.posterTokenImage) await this.posterTokenImage.update();
    } catch (err) {
      this.error('updateAlbumArt failed', (err as Error).message);
    }
  }

  private titleFor(item: NowPlayingItem): string {
    if (item.Type === 'Episode' && item.SeriesName) return item.SeriesName;
    return item.Name ?? '';
  }

  private subtitleFor(item: NowPlayingItem): string {
    if (item.Type === 'Episode') {
      const s = item.ParentIndexNumber ?? 0;
      const e = item.IndexNumber ?? 0;
      return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')} · ${item.Name ?? ''}`;
    }
    if (item.Type === 'Movie' && item.ProductionYear) return `${item.ProductionYear}`;
    return item.Type ?? '';
  }

  private async fireMediaTrigger(
    cardId: string,
    item: NowPlayingItem,
    snap: ClientSnapshot,
  ): Promise<void> {
    const tokens: Record<string, unknown> = {
      title: item.Name ?? '',
      type: item.Type ?? '',
      series: item.SeriesName ?? '',
      season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
      episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
      runtime: snap.durationSeconds ?? 0,
      user: snap.userName ?? this.store.userName,
    };
    if (cardId === 'playback_started' && this.posterTokenImage) {
      tokens.poster = this.posterTokenImage;
    }
    try {
      await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, tokens as never, undefined);
    } catch (err) {
      this.error(`${cardId} trigger failed`, (err as Error).message);
    }
  }

  private async safeSet(capability: string, value: unknown): Promise<void> {
    try {
      if (!this.hasCapability(capability)) return;
      await this.setCapabilityValue(capability, value as never);
    } catch (err) {
      this.error(`setCapabilityValue ${capability} failed`, (err as Error).message);
    }
  }
}

module.exports = JellyfinUserDevice;
