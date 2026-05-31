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
  libraryPollMinutes?: number;
  fallbackPollSeconds?: number;
}

const ITEM_CACHE_KEY_PREFIX = 'itemCache:';

export default class JellyfinServerDevice extends Homey.Device {
  private hub?: ServerHub;
  private offCallbacks: Array<() => void> = [];
  private serverId!: string;

  async onInit(): Promise<void> {
    this.serverId = this.getData().id.replace(/^server:/, '');
    await this.bootstrapHub();
  }

  private async bootstrapHub(): Promise<void> {
    const store = this.getStore() as ServerStore;
    const settings = this.getSettings() as ServerSettings;
    const app = this.homey.app as HomeyfinApp;

    // First-time: sync store → settings so the UI shows the connection details.
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
      persistedItemIds,
      saveItemIds: (ids) => this.homey.settings.set(ITEM_CACHE_KEY_PREFIX + this.serverId, ids),
      libraryPollMs: (settings.libraryPollMinutes ?? 5) * 60_000,
      fallbackPollMs: (settings.fallbackPollSeconds ?? 30) * 1_000,
    });

    this.registerHubHandlers();

    const cached = this.hub.getLastCounts();
    if (cached) await this.applyCounts(cached);
    await this.safeSet('scan_in_progress', false);

    this.registerFlowHandlers();
    this.setAvailable().catch(() => undefined);
  }

  async onSettings({ newSettings, changedKeys }: {
    oldSettings: ServerSettings;
    newSettings: ServerSettings;
    changedKeys: string[];
  }): Promise<void> {
    const connectionTouched = ['baseUrl', 'apiKey', 'userName'].some((k) => changedKeys.includes(k));
    const pollTouched = ['libraryPollMinutes', 'fallbackPollSeconds'].some((k) => changedKeys.includes(k));

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
  }

  private unregister(): void {
    for (const off of this.offCallbacks) off();
    this.offCallbacks = [];
  }

  // --- Hub event wiring ---

  private registerHubHandlers(): void {
    if (!this.hub) return;
    const onCounts = (counts: ItemCounts) => this.applyCounts(counts).catch((e) => this.error(e));
    const onNewItem = (ev: NewItemEvent) => this.handleNewItem(ev).catch((e) => this.error(e));
    const onScan = (duration: number) =>
      this.handleScanFinished(duration).catch((e) => this.error(e));
    const onUser = (data: { user: string; client: string; deviceName: string }) =>
      this.handleUserLoggedIn(data).catch((e) => this.error(e));

    this.hub.on('library:counts', onCounts);
    this.hub.on('library:new_item', onNewItem);
    this.hub.on('library:scan_finished', onScan);
    this.hub.on('user:logged_in', onUser);

    this.offCallbacks.push(
      () => this.hub?.off('library:counts', onCounts),
      () => this.hub?.off('library:new_item', onNewItem),
      () => this.hub?.off('library:scan_finished', onScan),
      () => this.hub?.off('user:logged_in', onUser),
    );
  }

  // --- Flow registration ---

  private registerFlowHandlers(): void {
    const newItemTrigger = this.homey.flow.getDeviceTriggerCard('new_item_added');
    newItemTrigger.registerRunListener(async (args, state: { type: string }) => {
      const wanted = (args.item_type as string) ?? 'any';
      if (wanted === 'any') return true;
      return state.type === wanted;
    });

    const scanAction = this.homey.flow.getActionCard('start_library_scan');
    scanAction.registerRunListener(async (args) => {
      const library = args.library as { id: string } | undefined;
      if (!this.hub) throw new Error('Server not connected');
      this.hub.markScanStarted();
      await this.safeSet('scan_in_progress', true);
      await this.hub.client.refreshLibrary(library?.id);
    });
    scanAction.registerArgumentAutocompleteListener('library', async (query) => {
      if (!this.hub) return [];
      const folders = await this.hub.client.getMediaFolders();
      const items = folders.Items.map((f) => ({ name: f.Name, id: f.Id }));
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter((i) => i.name.toLowerCase().includes(q));
    });
  }

  // --- Event handlers ---

  private async applyCounts(counts: ItemCounts): Promise<void> {
    await this.safeSet('library_movies_count', counts.MovieCount ?? 0);
    await this.safeSet('library_series_count', counts.SeriesCount ?? 0);
    await this.safeSet('library_episodes_count', counts.EpisodeCount ?? 0);
  }

  private async handleNewItem(ev: NewItemEvent): Promise<void> {
    const item = ev.item;
    const tokens = {
      title: item.Name ?? '',
      type: item.Type ?? '',
      series: item.SeriesName ?? '',
      season: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : 0,
      episode: typeof item.IndexNumber === 'number' ? item.IndexNumber : 0,
      year: typeof item.ProductionYear === 'number' ? item.ProductionYear : 0,
      library_name: ev.libraryName,
      poster_url: ev.posterUrl ?? '',
    };
    await this.safeSet('last_added_title', this.describeItem(item));
    await this.homey.flow
      .getDeviceTriggerCard('new_item_added')
      .trigger(this, tokens, { type: item.Type ?? '' })
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
  }): Promise<void> {
    await this.homey.flow
      .getDeviceTriggerCard('user_logged_in')
      .trigger(this, { user: data.user, client: data.client, device_name: data.deviceName })
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
