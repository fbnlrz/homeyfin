import Homey from 'homey';
import { ServerHub, ServerHubOptions } from './lib/ServerHub';

/**
 * Homeyfin app. Owns the pool of ServerHubs (one per paired Jellyfin server)
 * so that both the server-device and any client-devices can share a single
 * WebSocket / API client per server.
 */
export default class HomeyfinApp extends Homey.App {
  private hubs = new Map<string, ServerHub>();

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
      debug: false,
    });

    this.hubs.set(opts.serverId, hub);
    hub.on('error', (err: Error) => this.error(`Hub ${opts.serverId} error:`, err.message));
    await hub.start();
    this.log(`Hub started for server ${opts.serverId}`);
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
