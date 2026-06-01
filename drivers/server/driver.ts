import Homey from 'homey';
import { JellyfinClient, JellyfinError, JellyfinUser } from '../../lib/JellyfinClient';
import type HomeyfinApp from '../../app';

interface VerifyPayload {
  baseUrl: string;
  apiKey: string;
}

interface FinalizePayload {
  userId: string;
  baseUrl?: string;
  apiKey?: string;
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

type JellyfinServerDevice = Homey.Device & {
  getHub(): import('../../lib/ServerHub').ServerHub | undefined;
  markScanStarted(): void;
  setScanInProgress(value: boolean): Promise<void>;
};

export default class JellyfinServerDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Server driver init');
    this.registerFlowHandlers();
  }

  /**
   * Flow cards are app-wide singletons. registerRunListener replaces the
   * previous handler, so registering per-device would silently break
   * multi-server setups. Listeners are bound at the driver level and
   * resolve the right device via args.device.
   */
  private registerFlowHandlers(): void {
    const newItemTrigger = this.homey.flow.getDeviceTriggerCard('new_item_added');
    newItemTrigger.registerRunListener(async (args, state: { type: string; libraryId?: string }) => {
      const wantedType = (args.item_type as string) ?? 'any';
      if (wantedType !== 'any' && state.type !== wantedType) return false;
      const wantedLib = args.library as { id?: string } | undefined;
      if (wantedLib?.id && wantedLib.id !== state.libraryId) return false;
      return true;
    });
    newItemTrigger.registerArgumentAutocompleteListener('library', async (query, args) => {
      const dev = (args as { device?: JellyfinServerDevice }).device;
      const hub = dev?.getHub();
      if (!hub) return [{ name: 'Any library', id: '' }];
      const folders = await hub.client.getMediaFolders().catch(() => ({ Items: [] as { Id: string; Name: string }[] }));
      const all: Array<{ name: string; id: string }> = [
        { name: 'Any library', id: '' },
        ...folders.Items.map((f) => ({ name: f.Name, id: f.Id })),
      ];
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((i) => i.name.toLowerCase().includes(q));
    });

    const userTrigger = this.homey.flow.getDeviceTriggerCard('user_logged_in');
    userTrigger.registerRunListener(async (args, state: { userId?: string; userName: string }) => {
      const wanted = args.user as { id?: string; name?: string } | undefined;
      if (!wanted?.id) return true;
      if (wanted.id === 'any') return true;
      return state.userId === wanted.id || state.userName === wanted.name;
    });
    userTrigger.registerArgumentAutocompleteListener('user', async (query, args) => {
      const dev = (args as { device?: JellyfinServerDevice }).device;
      const hub = dev?.getHub();
      const users = hub ? await hub.client.getUsers().catch(() => []) : [];
      const all: Array<{ name: string; id: string }> = [
        { name: 'Any user', id: 'any' },
        ...users.map((u) => ({ name: u.Name, id: u.Id })),
      ];
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((i) => i.name.toLowerCase().includes(q));
    });

    this.homey.flow
      .getConditionCard('stream_count_above')
      .registerRunListener(async (args: { device: JellyfinServerDevice; threshold: number }) => {
        return (args.device.getHub()?.getStreamCount() ?? 0) > (args.threshold ?? 0);
      });

    this.homey.flow
      .getActionCard('restart_server')
      .registerRunListener(async (args: { device: JellyfinServerDevice }) => {
        const hub = args.device.getHub();
        if (!hub) throw new Error('Server not connected');
        await hub.client.restartServer();
      });

    this.homey.flow
      .getActionCard('shutdown_server')
      .registerRunListener(async (args: { device: JellyfinServerDevice }) => {
        const hub = args.device.getHub();
        if (!hub) throw new Error('Server not connected');
        await hub.client.shutdownServer();
      });

    this.homey.flow
      .getActionCard('health_check')
      .registerRunListener(async (args: { device: JellyfinServerDevice }) => {
        const hub = args.device.getHub();
        if (!hub) throw new Error('Server not connected');
        const start = Date.now();
        try {
          const info = await hub.client.getSystemInfoFull();
          return {
            ok: true,
            version: info.Version,
            server: info.ServerName,
            latency_ms: Date.now() - start,
          };
        } catch (err) {
          return {
            ok: false,
            version: '',
            server: (err as Error).message,
            latency_ms: Date.now() - start,
          };
        }
      });

    const scanAction = this.homey.flow.getActionCard('start_library_scan');
    scanAction.registerRunListener(
      async (args: { device: JellyfinServerDevice; library?: { id: string } }) => {
        const hub = args.device.getHub();
        if (!hub) throw new Error('Server not connected');
        args.device.markScanStarted();
        await args.device.setScanInProgress(true);
        await hub.client.refreshLibrary(args.library?.id);
      },
    );
    scanAction.registerArgumentAutocompleteListener('library', async (query, args) => {
      const dev = (args as { device?: JellyfinServerDevice }).device;
      const hub = dev?.getHub();
      if (!hub) return [];
      const folders = await hub.client.getMediaFolders().catch(() => ({ Items: [] as { Id: string; Name: string }[] }));
      const items = folders.Items.map((f) => ({ name: f.Name, id: f.Id }));
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter((i) => i.name.toLowerCase().includes(q));
    });
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

    session.setHandler('finalize', async (payload: FinalizePayload): Promise<ServerListDevice> => {
      // Re-probe with the credentials from the frontend so we don't rely on
      // any in-memory cross-view state (which has proven unreliable).
      const effective = (payload.baseUrl && payload.apiKey)
        ? await probeServer(this.homey, app.manifest?.version ?? '0.0.0', payload.baseUrl, payload.apiKey)
        : state;
      if (!effective) throw new Error('Run "verify" first');
      state = effective;

      const user = effective.users.find((u) => u.Id === payload.userId);
      if (!user) throw new Error('Selected user not found');
      return {
        name: `Jellyfin · ${effective.serverName}`,
        data: { id: `server:${effective.serverId}` },
        store: {
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
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

    session.setHandler('finalize', async (payload: FinalizePayload): Promise<ServerListDevice> => {
      const effective = (payload.baseUrl && payload.apiKey)
        ? await probeServer(this.homey, app.manifest?.version ?? '0.0.0', payload.baseUrl, payload.apiKey)
        : state;
      if (!effective) throw new Error('Run "verify" first');
      if (`server:${effective.serverId}` !== device.getData().id) {
        throw new Error(
          'Repair target mismatch: those credentials point to a different Jellyfin server.',
        );
      }
      state = effective;

      const user = effective.users.find((u) => u.Id === payload.userId);
      if (!user) throw new Error('Selected user not found');

      await device.setStoreValue('baseUrl', effective.baseUrl).catch(() => undefined);
      await device.setStoreValue('apiKey', effective.apiKey).catch(() => undefined);
      await device.setStoreValue('userId', user.Id).catch(() => undefined);
      await device.setStoreValue('userName', user.Name).catch(() => undefined);
      await device
        .setSettings({
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          userName: user.Name,
        })
        .catch(() => undefined);

      await app.releaseHub(effective.serverId);
      return {
        name: `Jellyfin · ${effective.serverName}`,
        data: { id: `server:${effective.serverId}` },
        store: {
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          userId: user.Id,
          userName: user.Name,
        },
      };
    });
  }
}

module.exports = JellyfinServerDriver;
