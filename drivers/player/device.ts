import Homey from 'homey';
import type HomeyfinApp from '../../app';
import { ClientSnapshot, ServerHub } from '../../lib/ServerHub';
import type { NowPlayingItem } from '../../lib/JellyfinClient';

interface PlayerStore {
  serverId: string;
  deviceId: string;
  userId: string;
  userName: string;
  deviceName: string;
  clientName: string;
}

interface PlayerSettings {
  volumeCapPercent?: number;
}

const POSITION_TICK_MS = 1000;

export default class JellyfinPlayerDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private store!: PlayerStore;
  private positionTimer?: NodeJS.Timeout;
  private initRetryTimer?: NodeJS.Timeout;
  private albumArtImage?: Homey.Image;
  private lastArtworkUrl = '';

  async onInit(): Promise<void> {
    this.store = this.getStore() as PlayerStore;
    const app = this.homey.app as HomeyfinApp;

    this.hub = app.getHub(this.store.serverId);
    if (!this.hub) {
      this.setUnavailable('Jellyfin server not connected yet').catch(() => undefined);
      this.initRetryTimer = this.homey.setTimeout(
        () => this.onInit().catch((e) => this.error(e)),
        5_000,
      );
      return;
    }

    await this.setupAlbumArt().catch((err) =>
      this.error('setupAlbumArt failed', (err as Error).message),
    );
    this.registerCapabilityHandlers();
    this.registerHubHandlers();
    this.startPositionTicker();

    const snap = this.hub.getClientSnapshot(this.store.deviceId);
    if (snap) await this.applyClientSnapshot(snap);
    else await this.applyOffline();

    this.setAvailable().catch(() => undefined);
  }

  async onDeleted(): Promise<void> {
    this.teardown();
  }

  async onUninit(): Promise<void> {
    this.teardown();
  }

  private teardown(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
    if (this.initRetryTimer) this.homey.clearTimeout(this.initRetryTimer);
    if (this.positionTimer) this.homey.clearInterval(this.positionTimer);
    this.initRetryTimer = undefined;
    this.positionTimer = undefined;
  }

  private async setupAlbumArt(): Promise<void> {
    const img = await this.homey.images.createImage();
    (img as any).setStream(async (stream: NodeJS.WritableStream) => {
      const url = this.lastArtworkUrl;
      if (!url) {
        stream.end();
        return;
      }
      const cached = await this.hub?.client.getCachedImage(url);
      if (cached) stream.write(cached.buffer);
      stream.end();
    });
    this.albumArtImage = img;
    await this.setAlbumArtImage(img).catch(() => undefined);
  }

  // --- Hub event wiring --------------------------------------------------

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const onUpdate = (snap: ClientSnapshot) =>
      this.applyClientSnapshot(snap).catch((e) => this.error(e));
    const ev = `client:${this.store.deviceId}:update`;
    this.hub.on(ev, onUpdate);
    this.offCallbacks.push(() => this.hub?.off(ev, onUpdate));
  }

  private startPositionTicker(): void {
    if (this.positionTimer) return;
    this.positionTimer = this.homey.setInterval(() => {
      const snap = this.hub?.getClientSnapshot(this.store.deviceId);
      if (
        !snap ||
        snap.userId !== this.store.userId ||
        !snap.online ||
        snap.isPaused ||
        !snap.nowPlaying
      ) {
        return;
      }
      const current = (this.getCapabilityValue('media_position') as number | null) ?? 0;
      const duration = snap.durationSeconds ?? 0;
      const next = duration > 0 ? Math.min(current + 1, duration) : current + 1;
      this.safeSet('media_position', next).catch(() => undefined);
    }, POSITION_TICK_MS);
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
      const settings = this.getSettings() as PlayerSettings;
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

  /** Live session id for this client + user, so commands hit the current session. */
  async requireSessionId(): Promise<string> {
    const snap = await this.liveClientSnapshot();
    if (!snap || !snap.online || !snap.sessionId) {
      throw new Error('This player has no active Jellyfin session right now');
    }
    return snap.sessionId;
  }

  private async liveClientSnapshot(): Promise<ClientSnapshot | undefined> {
    if (!this.hub) return undefined;
    try {
      const live = await this.hub.getLiveClientSession(this.store.deviceId, this.store.userId);
      if (live) return live;
    } catch (err) {
      this.error('live session lookup failed', (err as Error).message);
    }
    const cached = this.hub.getClientSnapshot(this.store.deviceId);
    return cached && cached.userId === this.store.userId ? cached : undefined;
  }

  // --- Snapshot application ----------------------------------------------

  private async applyClientSnapshot(snap: ClientSnapshot): Promise<void> {
    // The device is bound to one user on this client; ignore other users' sessions.
    if (snap.userId && snap.userId !== this.store.userId) {
      await this.applyOffline();
      return;
    }

    await this.safeSet('client_online', snap.online);
    await this.safeSet('is_transcoding', snap.isTranscoding);
    await this.safeSet('speaker_playing', Boolean(snap.nowPlaying && !snap.isPaused));

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
      await this.clearNowPlaying();
    }

    if (typeof snap.positionSeconds === 'number') {
      await this.safeSet('media_position', snap.positionSeconds);
    }
    await this.safeSet('media_duration', snap.durationSeconds ?? 0);

    await this.updateAlbumArt(snap.posterUrl ?? '');
  }

  private async applyOffline(): Promise<void> {
    await this.safeSet('client_online', false);
    await this.safeSet('is_transcoding', false);
    await this.safeSet('speaker_playing', false);
    await this.clearNowPlaying();
    await this.updateAlbumArt('');
  }

  private async clearNowPlaying(): Promise<void> {
    await this.safeSet('media_title', '');
    await this.safeSet('media_subtitle', '');
    await this.safeSet('speaker_track', '');
    await this.safeSet('speaker_artist', '');
    await this.safeSet('speaker_album', '');
  }

  private async updateAlbumArt(url: string): Promise<void> {
    if (url === this.lastArtworkUrl) return;
    this.lastArtworkUrl = url;
    try {
      if (this.albumArtImage) await this.albumArtImage.update();
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

  private async safeSet(capability: string, value: unknown): Promise<void> {
    try {
      if (!this.hasCapability(capability)) return;
      await this.setCapabilityValue(capability, value as never);
    } catch (err) {
      this.error(`setCapabilityValue ${capability} failed`, (err as Error).message);
    }
  }
}

module.exports = JellyfinPlayerDevice;
