import Homey from 'homey';
import { JellyfinClient, JellyfinError } from '../../lib/JellyfinClient';
import type HomeyfinApp from '../../app';

interface VerifyPayload {
  baseUrl: string;
  apiKey: string;
  userName?: string;
}

interface ServerListDevice {
  name: string;
  data: { id: string };
  store: {
    baseUrl: string;
    apiKey: string;
    userId: string;
    userName: string;
  };
}

export default class JellyfinServerDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Server driver init');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let pendingDevice: ServerListDevice | null = null;

    session.setHandler('verify', async (payload: VerifyPayload): Promise<ServerListDevice> => {
      const baseUrl = (payload.baseUrl ?? '').trim().replace(/\/+$/, '');
      const apiKey = (payload.apiKey ?? '').trim();
      const requestedUser = (payload.userName ?? '').trim();
      if (!baseUrl || !apiKey) throw new Error('URL and API key are required');

      const app = this.homey.app as HomeyfinApp;
      const homeyDeviceId = `homey-${await this.homey.cloud.getHomeyId().catch(() => 'unknown')}`;

      const client = new JellyfinClient({
        baseUrl,
        apiKey,
        deviceId: homeyDeviceId,
        deviceName: 'Homey',
        clientName: 'Homeyfin',
        appVersion: app.manifest?.version ?? '0.0.0',
      });

      let info;
      try {
        info = await client.getSystemInfo();
      } catch (err) {
        if (err instanceof JellyfinError) {
          throw new Error(`Could not connect (${err.status ?? '??'}): ${err.message}`);
        }
        throw err;
      }

      // Pick user id: requested by name, else first admin user.
      const users = await client.getUsers().catch(() => []);
      let chosen = users.find((u) => requestedUser && u.Name.toLowerCase() === requestedUser.toLowerCase());
      if (!chosen) chosen = users[0];
      if (!chosen) throw new Error('No users found on server');

      const device: ServerListDevice = {
        name: `Jellyfin · ${info.ServerName}`,
        data: { id: `server:${info.Id}` },
        store: {
          baseUrl,
          apiKey,
          userId: chosen.Id,
          userName: chosen.Name,
        },
      };
      pendingDevice = device;
      return device;
    });

    session.setHandler('list_device', async (device: ServerListDevice) => {
      pendingDevice = device;
    });

    session.setHandler('list_devices', async (): Promise<ServerListDevice[]> => {
      return pendingDevice ? [pendingDevice] : [];
    });
  }
}

module.exports = JellyfinServerDriver;
