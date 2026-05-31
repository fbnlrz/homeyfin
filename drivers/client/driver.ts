import Homey from 'homey';
import type HomeyfinApp from '../../app';

interface ServerOption {
  id: string;
  name: string;
  baseUrl: string;
}

interface ClientListDevice {
  name: string;
  data: { id: string };
  store: {
    serverId: string;
    deviceId: string;
    clientName: string;
    deviceName: string;
  };
}

export default class JellyfinClientDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Client driver init');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let selectedServerId: string | null = null;

    session.setHandler('list_servers', async (): Promise<ServerOption[]> => {
      const serverDriver = this.homey.drivers.getDriver('server');
      const devices = serverDriver.getDevices();
      return devices.map((d) => {
        const store = d.getStore() as { baseUrl: string };
        const id = d.getData().id.replace(/^server:/, '');
        return { id, name: d.getName(), baseUrl: store.baseUrl };
      });
    });

    session.setHandler('server_selected', async (serverId: string) => {
      selectedServerId = serverId;
    });

    session.setHandler('list_devices', async (): Promise<ClientListDevice[]> => {
      if (!selectedServerId) {
        const serverDriver = this.homey.drivers.getDriver('server');
        const first = serverDriver.getDevices()[0];
        if (!first) throw new Error('No paired Jellyfin server. Pair a server device first.');
        selectedServerId = first.getData().id.replace(/^server:/, '');
      }
      const serverId: string = selectedServerId as string;

      const hub = app.getHub(serverId);
      if (!hub) throw new Error('Server hub not initialised yet. Try again in a moment.');

      const devicesResp = await hub.client.getDevices();
      const sessions = await hub.client.getSessions().catch(() => []);
      const onlineDeviceIds = new Set(sessions.map((s) => s.DeviceId));

      const existing = new Set(this.getDevices().map((d) => d.getData().id));

      const items: ClientListDevice[] = devicesResp.Items.filter((d) => !!d.Id && !!d.Name).map((d) => {
        const compositeId = `${serverId}:${d.Id}`;
        const labelParts = [d.Name];
        if (d.AppName) labelParts.push(d.AppName);
        if (d.LastUserName) labelParts.push(`@${d.LastUserName}`);
        const suffix = onlineDeviceIds.has(d.Id) ? ' · online' : '';
        return {
          name: labelParts.join(' · ') + suffix,
          data: { id: compositeId },
          store: {
            serverId: serverId,
            deviceId: d.Id,
            clientName: d.AppName ?? '',
            deviceName: d.Name,
          },
        };
      });

      return items.filter((i) => !existing.has(i.data.id));
    });
  }
}

module.exports = JellyfinClientDriver;
