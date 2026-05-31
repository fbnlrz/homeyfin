import Homey from 'homey';
import type HomeyfinApp from '../../app';
import { ClientSnapshot, ServerHub } from '../../lib/ServerHub';
import type { NowPlayingItem } from '../../lib/JellyfinClient';

interface ClientStore {
  serverId: string;
  deviceId: string;
  clientName: string;
  deviceName: string;
}

interface ClientSettings {
  stoppedDebounceMs?: number;
}

const POSITION_TICK_MS = 1000;

export default class JellyfinClientDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private store!: ClientStore;
  private positionTimer?: NodeJS.Timeout;
  private stoppedDebounceTimer?: NodeJS.Timeout;
  private pendingStop?: { snap: ClientSnapshot; item: NowPlayingItem | undefined };
  private albumArtImage?: Homey.Image;
  private lastArtworkUrl = '';

  async onInit(): Promise<void> {
    this.store = this.getStore() as ClientStore;
    const app = this.homey.app as HomeyfinApp;

    this.hub = app.getHub(this.store.serverId);
    if (!this.hub) {
      this.setUnavailable('Jellyfin server not connected yet').catch(() => undefined);
      this.homey.setTimeout(() => this.onInit().catch((e) => this.error(e)), 5_000);
      return;
    }

    await this.setupAlbumArt().catch((err) => this.error('setupAlbumArt failed', (err as Error).message));
    this.registerCapabilityHandlers();
    this.registerHubHandlers();
    this.registerFlowHandlers();
    this.startPositionTicker();

    const snap = this.hub.getClientSnapshot(this.store.deviceId);
    if (snap) await this.applySnapshot(snap);
    else await this.safeSet('client_online', false);

    this.setAvailable().catch(() => undefined);
  }

  async onDeleted(): Promise<void> {
    this.teardown();
  }

  async onSettings(): Promise<void> {
    // No restart needed; debounce setting is read on the fly.
  }

  private teardown(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = undefined;
    }
    if (this.stoppedDebounceTimer) {
      clearTimeout(this.stoppedDebounceTimer);
      this.stoppedDebounceTimer = undefined;
    }
  }

  private async setupAlbumArt(): Promise<void> {
    this.albumArtImage = await this.homey.images.createImage();
    (this.albumArtImage as any).setUrl('');
    await this.setAlbumArtImage(this.albumArtImage).catch(() => undefined);
  }

  // --- Position ticker ---------------------------------------------------

  private startPositionTicker(): void {
    if (this.positionTimer) return;
    this.positionTimer = setInterval(() => {
      const snap = this.hub?.getClientSnapshot(this.store.deviceId);
      if (!snap || !snap.online || snap.isPaused || !snap.nowPlaying) return;
      const current = (this.getCapabilityValue('media_position') as number | null) ?? 0;
      const duration = snap.durationSeconds ?? 0;
      const next = duration > 0 ? Math.min(current + 1, duration) : current + 1;
      this.safeSet('media_position', next).catch(() => undefined);
    }, POSITION_TICK_MS);
  }

  // --- Hub event wiring --------------------------------------------------

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const deviceId = this.store.deviceId;

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

    const ev = (suffix: string) => `client:${deviceId}:${suffix}`;
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
    const settings = this.getSettings() as ClientSettings;
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
    // Re-check: if a new session for this device exists, suppress the stop.
    const current = this.hub?.getClientSnapshot(this.store.deviceId);
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
    const snap = this.hub?.getClientSnapshot(this.store.deviceId);
    if (!snap || !snap.online || !snap.sessionId) {
      throw new Error('Client is offline');
    }
    return snap.sessionId;
  }

  // --- Flow registration -------------------------------------------------

  private registerFlowHandlers(): void {
    this.homey.flow
      .getConditionCard('is_playing')
      .registerRunListener(async () => {
        const snap = this.hub?.getClientSnapshot(this.store.deviceId);
        return Boolean(snap?.nowPlaying && !snap.isPaused);
      });

    this.homey.flow
      .getConditionCard('media_type_is')
      .registerRunListener(async (args: { media_type: string }) => {
        const snap = this.hub?.getClientSnapshot(this.store.deviceId);
        return snap?.nowPlaying?.Type === args.media_type;
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
  }

  // --- Snapshot application ----------------------------------------------

  private async applySnapshot(snap: ClientSnapshot): Promise<void> {
    await this.safeSet('client_online', snap.online);

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

    // Snapshot wins over the local ticker — keep them in sync on every update.
    if (typeof snap.positionSeconds === 'number') {
      await this.safeSet('media_position', snap.positionSeconds);
    }
    await this.safeSet('media_duration', snap.durationSeconds ?? 0);

    await this.updateAlbumArt(snap.posterUrl ?? '');
  }

  private async updateAlbumArt(url: string): Promise<void> {
    if (url === this.lastArtworkUrl) return;
    this.lastArtworkUrl = url;
    if (!this.albumArtImage) return;
    try {
      (this.albumArtImage as any).setUrl(url || '');
      await this.albumArtImage.update();
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
    const tokens = {
      title: item.Name ?? '',
      type: item.Type ?? '',
      series: item.SeriesName ?? '',
      season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
      episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
      runtime: snap.durationSeconds ?? 0,
      user: snap.userName ?? '',
    };
    try {
      await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, tokens, undefined);
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

module.exports = JellyfinClientDevice;
