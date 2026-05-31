import Homey from 'homey';
import { JellyfinClient, JellyfinError, JellyfinUser } from '../../lib/JellyfinClient';
import type HomeyfinApp from '../../app';

interface VerifyPayload {
  baseUrl: string;
  apiKey: string;
}

interface FinalizePayload {
  userId: string;
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

interface PairState {
  baseUrl: string;
  apiKey: string;
  serverId: string;
  serverName: string;
  users: Array<JellyfinUser & { IsAdministrator?: boolean }>;
}

async function probeServer(
  homey: any,
  appVersion: string,
  baseUrl: string,
  apiKey: string,
): Promise<PairState> {
  const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
  const cleanKey = apiKey.trim();
  if (!cleanUrl || !cleanKey) throw new Error('URL and API key are required');

  const homeyDeviceId = `homey-${await homey.cloud.getHomeyId().catch(() => 'unknown')}`;
  const client = new JellyfinClient({
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    deviceId: homeyDeviceId,
    deviceName: 'Homey',
    clientName: 'Homeyfin',
    appVersion,
  });

  let info;
  try {
    info = await client.getSystemInfo();
  } catch (err) {
    throw new Error(
      err instanceof JellyfinError
        ? `Could not reach Jellyfin (${err.status ?? '??'}): ${err.message}`
        : `Could not reach Jellyfin: ${(err as Error).message}`,
    );
  }

  let users: JellyfinUser[] = [];
  try {
    users = await client.getUsers();
  } catch (err) {
    throw new Error(`Got system info but /Users failed: ${(err as Error).message}`);
  }
  if (users.length === 0) throw new Error('Server returned no users');

  return {
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    serverId: info.Id,
    serverName: info.ServerName,
    users: users as PairState['users'],
  };
}

export default class JellyfinServerDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Server driver init');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let state: PairState | null = null;

    session.setHandler('verify_connection', async (payload: VerifyPayload) => {
      this.log('pair verify', { baseUrl: payload.baseUrl });
      state = await probeServer(this.homey, app.manifest?.version ?? '0.0.0', payload.baseUrl, payload.apiKey);
      this.log('pair verify OK', state.serverName, `${state.users.length} users`);
      return { server: state.serverName, users: state.users };
    });

    session.setHandler('list_users', async () => {
      if (!state) throw new Error('Run "verify" first');
      return state.users;
    });

    session.setHandler('finalize', async ({ userId }: FinalizePayload): Promise<ServerListDevice> => {
      if (!state) throw new Error('Run "verify" first');
      const user = state.users.find((u) => u.Id === userId);
      if (!user) throw new Error('Selected user not found');
      return {
        name: `Jellyfin · ${state.serverName}`,
        data: { id: `server:${state.serverId}` },
        store: {
          baseUrl: state.baseUrl,
          apiKey: state.apiKey,
          userId: user.Id,
          userName: user.Name,
        },
      };
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let state: PairState | null = null;

    session.setHandler('verify_connection', async (payload: VerifyPayload) => {
      state = await probeServer(this.homey, app.manifest?.version ?? '0.0.0', payload.baseUrl, payload.apiKey);
      if (`server:${state.serverId}` !== device.getData().id) {
        throw new Error(
          'Repair target mismatch: those credentials point to a different Jellyfin server. ' +
            'Add a new server device instead.',
        );
      }
      return { server: state.serverName, users: state.users };
    });

    session.setHandler('list_users', async () => {
      if (!state) throw new Error('Run "verify" first');
      return state.users;
    });

    session.setHandler('finalize', async ({ userId }: FinalizePayload): Promise<ServerListDevice> => {
      if (!state) throw new Error('Run "verify" first');
      const user = state.users.find((u) => u.Id === userId);
      if (!user) throw new Error('Selected user not found');

      await device.setStoreValue('baseUrl', state.baseUrl).catch(() => undefined);
      await device.setStoreValue('apiKey', state.apiKey).catch(() => undefined);
      await device.setStoreValue('userId', user.Id).catch(() => undefined);
      await device.setStoreValue('userName', user.Name).catch(() => undefined);
      await device
        .setSettings({
          baseUrl: state.baseUrl,
          apiKey: state.apiKey,
          userName: user.Name,
        })
        .catch(() => undefined);

      const serverId = state.serverId;
      await app.releaseHub(serverId);
      return {
        name: `Jellyfin · ${state.serverName}`,
        data: { id: `server:${serverId}` },
        store: {
          baseUrl: state.baseUrl,
          apiKey: state.apiKey,
          userId: user.Id,
          userName: user.Name,
        },
      };
    });
  }
}

module.exports = JellyfinServerDriver;
