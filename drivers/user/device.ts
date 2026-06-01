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
  volumeCapPercent?: number;
  dailySummaryHour?: number;
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
  private watchSecondsThisWeek = 0;
  private watchSecondsToday = 0;
  private lastWatchTickDay = -1;
  private lastWatchTickWeek = -1;
  private summaryTimer?: NodeJS.Timeout;

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
    this.scheduleSummary();

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
    if (changedKeys.includes('dailySummaryHour')) {
      this.scheduleSummary();
    }
  }

  private teardown(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
    if (this.positionTimer) clearInterval(this.positionTimer);
    if (this.unwatchedTimer) clearInterval(this.unwatchedTimer);
    if (this.stoppedDebounceTimer) clearTimeout(this.stoppedDebounceTimer);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.positionTimer = undefined;
    this.unwatchedTimer = undefined;
    this.stoppedDebounceTimer = undefined;
    this.summaryTimer = undefined;
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
        const cached = await this.hub?.client.getCachedImage(url);
        if (cached) stream.write(cached.buffer);
        stream.end();
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
    // Hydrate accumulated watch-time from settings so a restart doesn't reset.
    const stored = this.homey.settings.get(
      'watch:' + this.store.userId,
    ) as { week?: number; day?: number; weekIdx?: number; dayIdx?: number } | undefined;
    if (stored) {
      this.watchSecondsThisWeek = stored.week ?? 0;
      this.watchSecondsToday = stored.day ?? 0;
      this.lastWatchTickWeek = stored.weekIdx ?? -1;
      this.lastWatchTickDay = stored.dayIdx ?? -1;
    }
    this.safeSet('watch_minutes_week', Math.floor(this.watchSecondsThisWeek / 60)).catch(() => undefined);

    this.positionTimer = setInterval(() => {
      const snap = this.hub?.getUserSnapshot(this.store.userId);
      if (!snap || !snap.online || snap.isPaused || !snap.nowPlaying) return;
      const current = (this.getCapabilityValue('media_position') as number | null) ?? 0;
      const duration = snap.durationSeconds ?? 0;
      const next = duration > 0 ? Math.min(current + 1, duration) : current + 1;
      this.safeSet('media_position', next).catch(() => undefined);
      this.checkProgressTriggers(snap, next, duration);
      this.tickWatchTime();
    }, POSITION_TICK_MS);
  }

  private tickWatchTime(): void {
    const now = new Date();
    const dayIdx = Math.floor(now.getTime() / 86_400_000);
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // ISO: Monday=0
    const weekIdx = Math.floor(weekStart.getTime() / 604_800_000);

    if (this.lastWatchTickDay !== -1 && this.lastWatchTickDay !== dayIdx) {
      this.watchSecondsToday = 0;
    }
    if (this.lastWatchTickWeek !== -1 && this.lastWatchTickWeek !== weekIdx) {
      this.watchSecondsThisWeek = 0;
    }
    this.lastWatchTickDay = dayIdx;
    this.lastWatchTickWeek = weekIdx;

    this.watchSecondsToday++;
    this.watchSecondsThisWeek++;

    // Persist + capability update every 30 s to keep settings writes cheap.
    if (this.watchSecondsThisWeek % 30 === 0) {
      this.safeSet('watch_minutes_week', Math.floor(this.watchSecondsThisWeek / 60)).catch(() => undefined);
      this.homey.settings.set('watch:' + this.store.userId, {
        week: this.watchSecondsThisWeek,
        day: this.watchSecondsToday,
        weekIdx,
        dayIdx,
      });
    }
  }

  private scheduleSummary(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    const settings = this.getSettings() as UserSettings;
    const hour = ((settings.dailySummaryHour ?? 22) + 24) % 24;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    this.summaryTimer = this.homey.setTimeout(() => {
      this.fireDailySummary().catch(() => undefined);
      this.scheduleSummary();
    }, delay);
  }

  private async fireDailySummary(): Promise<void> {
    try {
      await this.homey.flow
        .getDeviceTriggerCard('daily_summary')
        .trigger(
          this,
          {
            minutes_today: Math.floor(this.watchSecondsToday / 60),
            minutes_week: Math.floor(this.watchSecondsThisWeek / 60),
          },
          undefined,
        );
    } catch (err) {
      this.error('daily_summary trigger failed', (err as Error).message);
    }
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
      const settings = this.getSettings() as UserSettings;
      const cap = Math.min(100, Math.max(0, settings.volumeCapPercent ?? 0));
      let volume = Math.round(Math.max(0, Math.min(1, value)) * 100);
      if (cap > 0 && volume > cap) volume = cap;
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

    const randomAction = this.homey.flow.getActionCard('play_random');
    randomAction.registerRunListener(
      async (args: {
        item_type: 'Movie' | 'Episode';
        genre?: { id?: string; name?: string };
      }) => {
        const session = this.currentSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const res = await this.hub!.client.getRandomItems({
          userId,
          limit: 1,
          includeItemTypes: args.item_type,
          genres: args.genre?.name && args.genre.id !== 'any' ? args.genre.name : undefined,
        });
        const item = res.Items?.[0];
        if (!item) throw new Error('No item found for these filters');
        await this.hub!.client.playItemsOnSession(session.sessionId, [item.Id]);
        return { title: item.Name };
      },
    );
    randomAction.registerArgumentAutocompleteListener('genre', async (query, args: { item_type?: string }) => {
      if (!this.hub) return [{ name: 'Any', id: 'any' }];
      const res = await this.hub.client
        .getGenres({ userId, includeItemTypes: args.item_type })
        .catch(() => ({ Items: [] as { Id: string; Name: string }[] }));
      const all = [
        { name: 'Any', id: 'any' },
        ...res.Items.map((g) => ({ name: g.Name, id: g.Id })),
      ];
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((g) => g.name.toLowerCase().includes(q));
    });

    const queueAdd = this.homey.flow.getActionCard('queue_add');
    queueAdd.registerRunListener(
      async (args: { item: { id?: string }; where: 'PlayNext' | 'PlayLast' }) => {
        const session = this.currentSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        if (!args.item?.id) throw new Error('No item picked');
        await this.hub!.client.playItemsOnSession(session.sessionId, [args.item.id], {
          playCommand: args.where ?? 'PlayNext',
        });
      },
    );
    queueAdd.registerArgumentAutocompleteListener('item', async (query) => {
      if (!this.hub || !query || query.length < 2) return [];
      const res = await this.hub.client
        .searchItems({
          userId,
          searchTerm: query,
          limit: 20,
          includeItemTypes: 'Movie,Episode,Series,Audio',
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

    this.homey.flow.getActionCard('queue_clear').registerRunListener(async () => {
      const sessionId = await this.requireSessionId();
      await this.hub!.client.clearSessionQueue(sessionId);
    });

    this.homey.flow
      .getActionCard('skip_chapter')
      .registerRunListener(async (args: { direction: 'next' | 'prev' }) => {
        const session = this.currentSession();
        if (!session) throw new Error('User has no active Jellyfin session right now');
        const item = session.snap.nowPlaying;
        if (!item?.Id) throw new Error('Nothing is currently playing');
        const full = await this.hub!.client.getItem(userId, item.Id, 'Chapters');
        const chapters = (full.Chapters ?? []).map((c) => c.StartPositionTicks);
        if (chapters.length === 0) throw new Error('This item has no chapter data');
        const positionTicks = (session.snap.positionSeconds ?? 0) * 10_000_000;
        let target: number | undefined;
        if (args.direction === 'next') {
          target = chapters.find((t) => t > positionTicks + 1_000_000);
        } else {
          // 5s grace: prev means "this chapter's start if we're > 5s in, else previous one"
          const grace = 5 * 10_000_000;
          for (let i = chapters.length - 1; i >= 0; i--) {
            if (chapters[i] < positionTicks - grace) {
              target = chapters[i];
              break;
            }
          }
          if (target === undefined && chapters.length > 0) target = chapters[0];
        }
        if (target === undefined) throw new Error('No chapter in that direction');
        await this.hub!.client.seekToSeconds(session.sessionId, target / 10_000_000);
      });

    this.homey.flow
      .getActionCard('bookmark')
      .registerRunListener(async (args: { playlist_name?: string }): Promise<{ title: string }> => {
        const snap = this.hub?.getUserSnapshot(userId);
        const item = snap?.nowPlaying;
        if (!item?.Id) throw new Error('Nothing is currently playing');
        const playlistName = (args.playlist_name?.trim() || 'Homey Watchlist');
        const all = await this.hub!.client.getPlaylists(userId);
        let playlist = all.Items.find(
          (p) => p.Name?.toLowerCase() === playlistName.toLowerCase(),
        );
        let playlistId = playlist?.Id;
        if (!playlistId) {
          playlistId = await this.hub!.client.createPlaylist({
            userId,
            name: playlistName,
            itemIds: [item.Id],
          });
        } else {
          await this.hub!.client.addToPlaylist(playlistId, userId, [item.Id]);
        }
        return { title: item.Name ?? '' };
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
