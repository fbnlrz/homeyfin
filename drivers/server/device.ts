import Homey from 'homey';
import type HomeyfinApp from '../../app';
import { ServerHub, NewItemEvent } from '../../lib/ServerHub';
import type { ItemCounts, LatestItem } from '../../lib/JellyfinClient';

interface ServerStore {
  baseUrl: string;
  apiKey: string;
  userId: string;
  userName: string;
}

interface ServerSettings {
  baseUrl?: string;
  apiKey?: string;
  userName?: string;
  insecureTls?: boolean;
  libraryPollMinutes?: number;
  fallbackPollSeconds?: number;
  activePollSeconds?: number;
}

const ITEM_CACHE_KEY_PREFIX = 'itemCache:';

export default class JellyfinServerDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private serverId!: string;
  private posterImage?: Homey.Image;
  private lastPosterUrl = '';

  async onInit(): Promise<void> {
    this.serverId = this.getData().id.replace(/^server:/, '');
    await this.setupPosterImage();
    await this.bootstrapHub();
  }

  private async setupPosterImage(): Promise<void> {
    try {
      this.posterImage = await this.homey.images.createImage();
      (this.posterImage as any).setStream(async (stream: NodeJS.WritableStream) => {
        const url = this.lastPosterUrl;
        if (!url) {
          stream.end();
          return;
        }
        const cached = await this.hub?.client.getCachedImage(url);
        if (cached) stream.write(cached.buffer);
        stream.end();
      });
    } catch (err) {
      this.error('poster image setup failed', (err as Error).message);
    }
  }

  private uptimePollTimer?: NodeJS.Timeout;
  private async refreshUptime(): Promise<void> {
    if (!this.hub) return;
    try {
      // Jellyfin doesn't expose uptime directly. Persist the first time we
      // successfully see the server and report minutes since then. The
      // timestamp is cleared in onDeleted so re-pairing starts fresh.
      const key = 'serverStartTs:' + this.serverId;
      let started = this.homey.settings.get(key) as number | undefined;
      if (!started) {
        started = Date.now();
        this.homey.settings.set(key, started);
      }
      await this.safeSet(
        'server_uptime',
        Math.max(0, Math.round((Date.now() - started) / 60_000)),
      );
    } catch (err) {
      this.error('refreshUptime failed', (err as Error).message);
    }
  }

  private startUptimePoll(): void {
    if (this.uptimePollTimer) clearInterval(this.uptimePollTimer);
    this.uptimePollTimer = setInterval(() => this.refreshUptime().catch(() => undefined), 60_000);
  }

  private bootstrapInFlight?: Promise<void>;
  private async bootstrapHub(): Promise<void> {
    // Serialize concurrent invocations (onInit + onSettings races).
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    this.bootstrapInFlight = this.bootstrapHubInner().finally(() => {
      this.bootstrapInFlight = undefined;
    });
    return this.bootstrapInFlight;
  }

  private async bootstrapHubInner(): Promise<void> {
    const store = this.getStore() as ServerStore;
    const settings = this.getSettings() as ServerSettings;
    const app = this.homey.app as HomeyfinApp;

    if (!settings.baseUrl && store.baseUrl) {
      await this.setSettings({
        baseUrl: store.baseUrl,
        apiKey: store.apiKey,
        userName: store.userName,
      }).catch(() => undefined);
    }

    const baseUrl = settings.baseUrl?.trim() || store.baseUrl;
    const apiKey = settings.apiKey?.trim() || store.apiKey;
    const userId = store.userId;
    if (!baseUrl || !apiKey || !userId) {
      await this.setUnavailable('Missing connection details').catch(() => undefined);
      return;
    }

    const persistedRaw = this.homey.settings.get(ITEM_CACHE_KEY_PREFIX + this.serverId);
    const persistedItemIds: string[] = Array.isArray(persistedRaw) ? persistedRaw : [];

    this.hub = await app.getOrCreateHub({
      serverId: this.serverId,
      baseUrl,
      apiKey,
      userId,
      insecureTls: settings.insecureTls === true,
      persistedItemIds,
      saveItemIds: (ids) => this.homey.settings.set(ITEM_CACHE_KEY_PREFIX + this.serverId, ids),
      libraryPollMs: (settings.libraryPollMinutes ?? 5) * 60_000,
      fallbackPollMs: (settings.fallbackPollSeconds ?? 30) * 1_000,
      activePollMs: (settings.activePollSeconds ?? 5) * 1_000,
    });

    this.registerHubHandlers();

    const cached = this.hub.getLastCounts();
    if (cached) await this.applyCounts(cached);
    await this.safeSet('scan_in_progress', false);
    await this.safeSet('socket_online', this.hub.isSocketOpen());
    await this.safeSet('stream_count', this.hub.getStreamCount());
    await this.safeSet('transcoding_count', this.hub.getTranscodingCount());

    await this.refreshUptime();
    this.startUptimePoll();
    this.setAvailable().catch(() => undefined);
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: ServerSettings;
    newSettings: ServerSettings;
    changedKeys: string[];
  }): Promise<void> {
    const connectionTouched = ['baseUrl', 'apiKey', 'userName', 'insecureTls'].some((k) =>
      changedKeys.includes(k),
    );
    const pollTouched = ['libraryPollMinutes', 'fallbackPollSeconds', 'activePollSeconds'].some(
      (k) => changedKeys.includes(k),
    );

    if (connectionTouched || pollTouched) {
      this.log('Settings changed; recreating hub', changedKeys);
      this.unregister();
      const app = this.homey.app as HomeyfinApp;
      await app.releaseHub(this.serverId);
      await this.setStoreValue('baseUrl', newSettings.baseUrl ?? '').catch(() => undefined);
      await this.setStoreValue('apiKey', newSettings.apiKey ?? '').catch(() => undefined);
      if (newSettings.userName) {
        await this.setStoreValue('userName', newSettings.userName).catch(() => undefined);
      }
      await this.bootstrapHub();
    }
  }

  async onDeleted(): Promise<void> {
    this.unregister();
    const app = this.homey.app as HomeyfinApp;
    await app.releaseHub(this.serverId);
    this.homey.settings.unset(ITEM_CACHE_KEY_PREFIX + this.serverId);
    this.homey.settings.unset('serverStartTs:' + this.serverId);
  }

  private unregister(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
    if (this.uptimePollTimer) {
      clearInterval(this.uptimePollTimer);
      this.uptimePollTimer = undefined;
    }
  }

  // --- Hub event wiring ---

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const hub = this.hub;

    const onCounts = (counts: ItemCounts) =>
      this.applyCounts(counts).catch((e) => this.error(e));
    const onNewItem = (ev: NewItemEvent) =>
      this.handleNewItem(ev).catch((e) => this.error(e));
    const onScan = (duration: number) =>
      this.handleScanFinished(duration).catch((e) => this.error(e));
    const onUser = (data: { user: string; client: string; deviceName: string }) =>
      this.handleUserLoggedIn(data).catch((e) => this.error(e));
    const onUp = () => {
      this.safeSet('socket_online', true).catch(() => undefined);
      this.homey.flow
        .getDeviceTriggerCard('server_connected')
        .trigger(this, {}, undefined)
        .catch(() => undefined);
    };
    const onDown = () => {
      this.safeSet('socket_online', false).catch(() => undefined);
      this.homey.flow
        .getDeviceTriggerCard('server_disconnected')
        .trigger(this, {}, undefined)
        .catch(() => undefined);
    };
    const onStreams = (data: { count: number; transcoding: number }) => {
      this.safeSet('stream_count', data.count).catch(() => undefined);
      this.safeSet('transcoding_count', data.transcoding).catch(() => undefined);
      this.homey.flow
        .getDeviceTriggerCard('stream_count_changed')
        .trigger(this, { count: data.count, transcoding: data.transcoding }, undefined)
        .catch(() => undefined);
    };
    const onTransStart = (data: { user: string; deviceName: string; title: string; reasons: string[] }) => {
      this.homey.flow
        .getDeviceTriggerCard('transcoding_started')
        .trigger(
          this,
          {
            user: data.user,
            device_name: data.deviceName,
            title: data.title,
            reasons: (data.reasons || []).join(', '),
          },
          undefined,
        )
        .catch(() => undefined);
    };
    const onTransStop = (data: { user: string; title: string }) => {
      this.homey.flow
        .getDeviceTriggerCard('transcoding_stopped')
        .trigger(this, { user: data.user, title: data.title }, undefined)
        .catch(() => undefined);
    };

    hub.on('library:counts', onCounts);
    hub.on('library:new_item', onNewItem);
    hub.on('library:scan_finished', onScan);
    hub.on('user:logged_in', onUser);
    hub.on('connection:up', onUp);
    hub.on('connection:down', onDown);
    hub.on('streams:count', onStreams);
    hub.on('transcoding:started', onTransStart);
    hub.on('transcoding:stopped', onTransStop);

    this.offCallbacks.push(
      () => hub.off('library:counts', onCounts),
      () => hub.off('library:new_item', onNewItem),
      () => hub.off('library:scan_finished', onScan),
      () => hub.off('user:logged_in', onUser),
      () => hub.off('connection:up', onUp),
      () => hub.off('connection:down', onDown),
      () => hub.off('streams:count', onStreams),
      () => hub.off('transcoding:started', onTransStart),
      () => hub.off('transcoding:stopped', onTransStop),
    );
  }

  // --- Public accessors used by driver-level flow listeners (multi-device safe) ---

  getHub(): ServerHub | undefined {
    return this.hub;
  }

  markScanStarted(): void {
    this.hub?.markScanStarted();
  }

  async setScanInProgress(value: boolean): Promise<void> {
    await this.safeSet('scan_in_progress', value);
  }

  // --- Event handlers ---

  private async applyCounts(counts: ItemCounts): Promise<void> {
    await this.safeSet('library_movies_count', counts.MovieCount ?? 0);
    await this.safeSet('library_series_count', counts.SeriesCount ?? 0);
    await this.safeSet('library_episodes_count', counts.EpisodeCount ?? 0);
  }

  private async handleNewItem(ev: NewItemEvent): Promise<void> {
    const item = ev.item;
    this.lastPosterUrl = ev.posterUrl ?? '';
    if (this.posterImage) await this.posterImage.update().catch(() => undefined);

    const tokens: Record<string, unknown> = {
      title: item.Name ?? '',
      type: item.Type ?? '',
      series: item.SeriesName ?? '',
      season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
      episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
      year: typeof item.ProductionYear === 'number' ? item.ProductionYear : 0,
      library_name: ev.libraryName,
      poster_url: ev.posterUrl ?? '',
    };
    if (this.posterImage) tokens.poster = this.posterImage;
    await this.safeSet('last_added_title', this.describeItem(item));
    await this.homey.flow
      .getDeviceTriggerCard('new_item_added')
      .trigger(this, tokens as never, { type: item.Type ?? '', libraryId: item.ParentId })
      .catch((err: Error) => this.error('new_item_added trigger failed', err.message));
  }

  private async handleScanFinished(durationSeconds: number): Promise<void> {
    await this.safeSet('scan_in_progress', false);
    await this.homey.flow
      .getDeviceTriggerCard('library_scan_finished')
      .trigger(this, { duration_seconds: durationSeconds })
      .catch((err: Error) => this.error('library_scan_finished trigger failed', err.message));
  }

  private async handleUserLoggedIn(data: {
    user: string;
    client: string;
    deviceName: string;
    userId?: string;
  }): Promise<void> {
    await this.homey.flow
      .getDeviceTriggerCard('user_logged_in')
      .trigger(
        this,
        { user: data.user, client: data.client, device_name: data.deviceName },
        { userId: data.userId, userName: data.user },
      )
      .catch((err: Error) => this.error('user_logged_in trigger failed', err.message));
  }

  private describeItem(item: LatestItem): string {
    if (item.Type === 'Episode' && item.SeriesName) {
      const s = item.ParentIndexNumber ?? 0;
      const e = item.IndexNumber ?? 0;
      return `${item.SeriesName} · S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')} – ${item.Name}`;
    }
    if (item.Type === 'Movie' && item.ProductionYear) {
      return `${item.Name} (${item.ProductionYear})`;
    }
    return item.Name ?? '';
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

module.exports = JellyfinServerDevice;
