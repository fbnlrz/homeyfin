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
    session.setHandler('verify', async (payload: VerifyPayload): Promise<ServerListDevice> => {
      this.log('verify called', { baseUrl: payload.baseUrl, userName: payload.userName });

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
        const msg = err instanceof JellyfinError
          ? `Could not reach Jellyfin (${err.status ?? '??'}): ${err.message}`
          : `Could not reach Jellyfin: ${(err as Error).message}`;
        this.error('verify getSystemInfo failed', msg);
        throw new Error(msg);
      }
      this.log('verify systemInfo OK', { id: info.Id, name: info.ServerName, version: info.Version });

      let users: { Id: string; Name: string }[] = [];
      try {
        users = await client.getUsers();
      } catch (err) {
        this.error('verify getUsers failed', (err as Error).message);
        throw new Error(`Got system info but /Users failed: ${(err as Error).message}`);
      }

      let chosen = users.find(
        (u) => requestedUser && u.Name.toLowerCase() === requestedUser.toLowerCase(),
      );
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
      this.log('verify returning device', device.name);
      return device;
    });
  }
}

module.exports = JellyfinServerDriver;
