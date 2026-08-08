import Homey from 'homey';
import { ServerHub, ServerHubOptions } from './lib/ServerHub';

/**
 * Homeyfin app. Owns the pool of ServerHubs (one per paired Jellyfin server)
 * so that both the server-device and any client-devices can share a single
 * WebSocket / API client per server.
 */
export default class HomeyfinApp extends Homey.App {
  private hubs = new Map<string, ServerHub>();
  // serverId -> subscribers notified when that server's hub instance is
  // swapped (created anew or released). Survives releaseHub on purpose:
  // devices unsubscribe themselves via the returned function.
  private hubSwapSubs = new Map<string, Set<(hub: ServerHub | undefined) => void>>();

  async onInit(): Promise<void> {
    this.log('Homeyfin app starting');
  }

  async onUninit(): Promise<void> {
    this.log('Homeyfin app stopping; releasing hubs');
    for (const [serverId, hub] of this.hubs) {
      try {
        await hub.stop();
      } catch (err) {
        this.error(`Stopping hub ${serverId} failed:`, (err as Error).message);
      }
    }
    this.hubs.clear();
  }

  /**
   * Subscribes to hub swaps for a server: cb fires with the new hub when one
   * is created (a fresh instance from getOrCreateHub) and with undefined when
   * the hub is released. Returns an unsubscribe function.
   */
  onHubSwap(serverId: string, cb: (hub: ServerHub | undefined) => void): () => void {
    let subs = this.hubSwapSubs.get(serverId);
    if (!subs) {
      subs = new Set();
      this.hubSwapSubs.set(serverId, subs);
    }
    subs.add(cb);
    return () => {
      const set = this.hubSwapSubs.get(serverId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.hubSwapSubs.delete(serverId);
    };
  }

  private notifyHubSwap(serverId: string, hub: ServerHub | undefined): void {
    const subs = this.hubSwapSubs.get(serverId);
    if (!subs) return;
    // Copy first: a callback may (un)subscribe while we iterate.
    for (const cb of Array.from(subs)) {
      try {
        cb(hub);
      } catch (err) {
        this.error(`Hub swap callback for ${serverId} failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Returns an existing hub or creates one. Subsequent calls with the same
   * serverId return the same instance. Callers may pass tuning options
   * (poll intervals) and a persistence callback for the new-item cache.
   */
  async getOrCreateHub(
    opts: Omit<ServerHubOptions, 'homeyDeviceId' | 'appVersion'>,
  ): Promise<ServerHub> {
    const existing = this.hubs.get(opts.serverId);
    if (existing) return existing;

    const homeyDeviceId = await this.getHomeyDeviceId();
    const appVersion = this.manifest?.version ?? '0.0.0';

    const hub = new ServerHub({
      ...opts,
      homeyDeviceId,
      appVersion,
      // Seed the update-available edge from the persisted flag so the
      // update_available card doesn't re-fire on every app restart.
      initialUpdateAvailable:
        this.homey.settings.get('updateAvailable:' + opts.serverId) === true,
      debug: false,
      timers: {
        setInterval: this.homey.setInterval.bind(this.homey),
        clearInterval: this.homey.clearInterval.bind(this.homey),
        setTimeout: this.homey.setTimeout.bind(this.homey),
        clearTimeout: this.homey.clearTimeout.bind(this.homey),
      },
    });

    this.hubs.set(opts.serverId, hub);
    hub.on('error', (err: Error) => this.error(`Hub ${opts.serverId} error:`, err.message));
    // Persist the update-available flag so the edge survives app restarts
    // (read back via initialUpdateAvailable above).
    hub.on('server:update_available', () =>
      this.homey.settings.set('updateAvailable:' + opts.serverId, true),
    );
    hub.on('server:update_cleared', () =>
      this.homey.settings.set('updateAvailable:' + opts.serverId, false),
    );
    await hub.start();
    if (this.hubs.get(opts.serverId) !== hub) {
      // releaseHub() ran while start() was in flight: this instance is already
      // stopped (its listeners are gone too) and must never be notified or
      // handed out. Prefer whatever hub owns the map slot now; if none does,
      // fail the bootstrap instead of returning a zombie.
      await hub.stop().catch(() => undefined);
      const current = this.hubs.get(opts.serverId);
      if (current) return current;
      throw new Error(`Hub for server ${opts.serverId} was released during startup`);
    }
    this.log(`Hub started for server ${opts.serverId}`);
    this.notifyHubSwap(opts.serverId, hub);
    return hub;
  }

  getHub(serverId: string): ServerHub | undefined {
    return this.hubs.get(serverId);
  }

  listHubs(): ServerHub[] {
    return Array.from(this.hubs.values());
  }

  async releaseHub(serverId: string): Promise<void> {
    const hub = this.hubs.get(serverId);
    if (!hub) return;
    await hub.stop();
    this.hubs.delete(serverId);
    this.log(`Hub stopped for server ${serverId}`);
    this.notifyHubSwap(serverId, undefined);
  }

  private async getHomeyDeviceId(): Promise<string> {
    try {
      const cloudId = await this.homey.cloud.getHomeyId();
      return `homey-${cloudId}`;
    } catch {
      return 'homey-unknown';
    }
  }
}

module.exports = HomeyfinApp;
