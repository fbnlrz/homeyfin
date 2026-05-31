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

async function verifyConnection(
  homey: any,
  appVersion: string,
  payload: VerifyPayload,
): Promise<ServerListDevice> {
  const baseUrl = (payload.baseUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey = (payload.apiKey ?? '').trim();
  const requestedUser = (payload.userName ?? '').trim();
  if (!baseUrl || !apiKey) throw new Error('URL and API key are required');

  const homeyDeviceId = `homey-${await homey.cloud.getHomeyId().catch(() => 'unknown')}`;
  const client = new JellyfinClient({
    baseUrl,
    apiKey,
    deviceId: homeyDeviceId,
    deviceName: 'Homey',
    clientName: 'Homeyfin',
    appVersion,
  });

  let info;
  try {
    info = await client.getSystemInfo();
  } catch (err) {
    const msg = err instanceof JellyfinError
      ? `Could not reach Jellyfin (${err.status ?? '??'}): ${err.message}`
      : `Could not reach Jellyfin: ${(err as Error).message}`;
    throw new Error(msg);
  }

  let users: { Id: string; Name: string }[] = [];
  try {
    users = await client.getUsers();
  } catch (err) {
    throw new Error(`Got system info but /Users failed: ${(err as Error).message}`);
  }

  let chosen = users.find(
    (u) => requestedUser && u.Name.toLowerCase() === requestedUser.toLowerCase(),
  );
  if (!chosen) chosen = users[0];
  if (!chosen) throw new Error('No users found on server');

  return {
    name: `Jellyfin · ${info.ServerName}`,
    data: { id: `server:${info.Id}` },
    store: { baseUrl, apiKey, userId: chosen.Id, userName: chosen.Name },
  };
}

export default class JellyfinServerDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Server driver init');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    session.setHandler('verify', async (payload: VerifyPayload): Promise<ServerListDevice> => {
      this.log('pair verify', { baseUrl: payload.baseUrl, userName: payload.userName });
      const device = await verifyConnection(this.homey, app.manifest?.version ?? '0.0.0', payload);
      this.log('pair verify OK', device.name);
      return device;
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    session.setHandler('verify', async (payload: VerifyPayload): Promise<ServerListDevice> => {
      this.log('repair verify', { baseUrl: payload.baseUrl, userName: payload.userName });
      const verified = await verifyConnection(this.homey, app.manifest?.version ?? '0.0.0', payload);

      // Make sure the user is repairing the same server, not a different one.
      if (verified.data.id !== device.getData().id) {
        throw new Error(
          'Repair target mismatch: the credentials point to a different Jellyfin server. ' +
            'Add a new device instead.',
        );
      }

      // Persist new credentials in both store and settings so they appear in the UI.
      await device.setStoreValue('baseUrl', verified.store.baseUrl).catch(() => undefined);
      await device.setStoreValue('apiKey', verified.store.apiKey).catch(() => undefined);
      await device.setStoreValue('userId', verified.store.userId).catch(() => undefined);
      await device.setStoreValue('userName', verified.store.userName).catch(() => undefined);
      await device
        .setSettings({
          baseUrl: verified.store.baseUrl,
          apiKey: verified.store.apiKey,
          userName: verified.store.userName,
        })
        .catch(() => undefined);

      this.log('repair OK, restarting hub');
      const serverId = device.getData().id.replace(/^server:/, '');
      await app.releaseHub(serverId);
      // Device.onInit-like restart triggered by Homey when settings change is unreliable here;
      // we just rely on the existing settings-listener path or the next app start.

      return verified;
    });
  }
}

module.exports = JellyfinServerDriver;
