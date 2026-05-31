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

export default class JellyfinClientDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private store!: ClientStore;

  async onInit(): Promise<void> {
    this.store = this.getStore() as ClientStore;
    const app = this.homey.app as HomeyfinApp;

    this.hub = app.getHub(this.store.serverId);
    if (!this.hub) {
      this.setUnavailable(this.homey.__('Server not paired') ?? 'Server not paired').catch(() => undefined);
      // Retry shortly in case server device init is still running.
      this.homey.setTimeout(() => this.onInit().catch((e) => this.error(e)), 5_000);
      return;
    }

    this.registerCapabilityHandlers();
    this.registerHubHandlers();
    this.registerFlowHandlers();

    const snap = this.hub.getClientSnapshot(this.store.deviceId);
    if (snap) await this.applySnapshot(snap);
    else await this.safeSet('client_online', false);

    this.setAvailable().catch(() => undefined);
  }

  async onDeleted(): Promise<void> {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
  }

  // --- Hub event wiring ---

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const deviceId = this.store.deviceId;

    const onUpdate = (snap: ClientSnapshot) => this.applySnapshot(snap).catch((e) => this.error(e));
    const onStarted = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_started', item, snap);
    const onPaused = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_paused', item, snap);
    const onResumed = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_resumed', item, snap);
    const onStopped = (snap: ClientSnapshot, item: NowPlayingItem) =>
      this.fireMediaTrigger('playback_stopped', item, snap);
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

  // --- Capability listeners (Homey → Jellyfin) ---

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
      throw new Error(this.homey.__('Client is offline') ?? 'Client is offline');
    }
    return snap.sessionId;
  }

  // --- Flow registration ---

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

  // --- Snapshot application ---

  private async applySnapshot(snap: ClientSnapshot): Promise<void> {
    await this.safeSet('client_online', snap.online);

    const playing = Boolean(snap.nowPlaying && !snap.isPaused);
    await this.safeSet('speaker_playing', playing);

    if (typeof snap.volumeLevel === 'number') {
      await this.safeSet('volume_set', Math.max(0, Math.min(1, snap.volumeLevel / 100)));
    }
    await this.safeSet('volume_mute', snap.isMuted);

    if (snap.nowPlaying) {
      await this.safeSet('media_title', this.titleFor(snap.nowPlaying));
      await this.safeSet('media_subtitle', this.subtitleFor(snap.nowPlaying));
    } else {
      await this.safeSet('media_title', '');
      await this.safeSet('media_subtitle', '');
    }
    await this.safeSet('media_position', snap.positionSeconds ?? 0);
    await this.safeSet('media_duration', snap.durationSeconds ?? 0);
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
