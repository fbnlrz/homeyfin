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
  settings?: { insecureTls: boolean };
}

interface PairState {
  baseUrl: string;
  apiKey: string;
  serverId: string;
  serverName: string;
  users: Array<JellyfinUser & { IsAdministrator?: boolean }>;
  // Only set on the Quick-Connect path (where the checkbox value is known);
  // undefined means "leave the device's insecureTls setting untouched".
  insecureTls?: boolean;
}

interface ProbeOptions {
  insecureTls?: boolean;
  /**
   * Quick Connect: a non-admin token cannot list /Users — fall back to the
   * authenticated user instead of failing the whole probe.
   */
  fallbackUser?: JellyfinUser;
}

async function probeServer(
  homey: any,
  appVersion: string,
  baseUrl: string,
  apiKey: string,
  opts?: ProbeOptions,
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
    insecureTls: opts?.insecureTls === true,
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
    if (!opts?.fallbackUser) {
      throw new Error(`Got system info but /Users failed: ${(err as Error).message}`);
    }
  }
  if (users.length === 0 && opts?.fallbackUser) users = [opts.fallbackUser];
  if (users.length === 0) throw new Error('Server returned no users');

  return {
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    serverId: info.Id,
    serverName: info.ServerName,
    users: users as PairState['users'],
    insecureTls: opts?.insecureTls,
  };
}

type JellyfinServerDevice = Homey.Device & {
  getHub(): import('../../lib/ServerHub').ServerHub | undefined;
  markScanStarted(): void;
  setScanInProgress(value: boolean): Promise<void>;
  rebuildHub(settingsOverride?: {
    baseUrl?: string;
    apiKey?: string;
    userName?: string;
    insecureTls?: boolean;
  }): Promise<void>;
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

    // Scheduled tasks are fetched on demand (never cached in the driver) and
    // shared between the run_task action and the task_completed trigger.
    const taskAutocomplete = async (
      query: string,
      args: unknown,
      anyEntry: { name: string; id: string } | null,
    ): Promise<Array<{ name: string; id: string }>> => {
      const dev = (args as { device?: JellyfinServerDevice }).device;
      const hub = dev?.getHub();
      const tasks = hub ? await hub.client.getScheduledTasks().catch(() => []) : [];
      const all: Array<{ name: string; id: string }> = [
        ...(anyEntry ? [anyEntry] : []),
        ...tasks.map((t) => ({ name: t.name, id: t.id })),
      ];
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((i) => i.name.toLowerCase().includes(q));
    };

    const runTaskAction = this.homey.flow.getActionCard('run_task');
    runTaskAction.registerRunListener(
      async (args: { device: JellyfinServerDevice; task?: { id: string } }) => {
        const hub = args.device.getHub();
        if (!hub) throw new Error('Server not connected');
        if (!args.task?.id) throw new Error('Pick a task');
        await hub.runScheduledTask(args.task.id);
      },
    );
    runTaskAction.registerArgumentAutocompleteListener('task', (query, args) =>
      taskAutocomplete(query, args, null),
    );

    const taskCompletedTrigger = this.homey.flow.getDeviceTriggerCard('task_completed');
    taskCompletedTrigger.registerRunListener(async (args, state: { taskId: string }) => {
      const wanted = args.task as { id?: string } | undefined;
      if (!wanted?.id) return true; // 'Any task'
      return wanted.id === state.taskId;
    });
    taskCompletedTrigger.registerArgumentAutocompleteListener('task', (query, args) =>
      taskAutocomplete(query, args, { name: 'Any task', id: '' }),
    );

    // update_available and auth_failed have no filterable arguments — the
    // device arg alone needs no run listener (see server_connected).
  }

  /**
   * Quick-Connect handlers, shared by pairing and repair. qc_start checks the
   * server actually offers Quick Connect and returns the code to display;
   * qc_poll checks approval state and, once approved, exchanges the secret for
   * an access token and validates it exactly like the API-key path. The
   * resulting PairState (token as apiKey) is handed to setState so the
   * existing finalize handler can complete the flow without credentials in
   * the payload.
   */
  private registerQuickConnectHandlers(
    session: Homey.Driver.PairSession,
    setState: (state: PairState) => void,
    expectedDataId?: string,
  ): void {
    const app = this.homey.app as HomeyfinApp;
    let qcClient: JellyfinClient | null = null;
    let qcBaseUrl = '';
    let qcInsecureTls = false;

    session.setHandler('qc_start', async (payload: { baseUrl: string; insecureTls?: boolean }) => {
      const cleanUrl = (payload.baseUrl ?? '').trim().replace(/\/+$/, '');
      if (!cleanUrl) throw new Error('Server URL is required');
      qcBaseUrl = cleanUrl;
      qcInsecureTls = payload.insecureTls === true;

      const homeyDeviceId = `homey-${await this.homey.cloud.getHomeyId().catch(() => 'unknown')}`;
      // apiKey '' => unauthenticated client: the auth header carries no Token
      // part, which is what the QuickConnect bootstrap endpoints expect.
      qcClient = new JellyfinClient({
        baseUrl: cleanUrl,
        apiKey: '',
        deviceId: homeyDeviceId,
        deviceName: 'Homey',
        clientName: 'Homeyfin',
        appVersion: app.manifest?.version ?? '0.0.0',
        insecureTls: qcInsecureTls,
      });

      let enabled = false;
      try {
        enabled = await qcClient.quickConnectEnabled();
      } catch (err) {
        throw new Error(
          err instanceof JellyfinError
            ? `Could not reach Jellyfin (${err.status ?? '??'}): ${err.message}`
            : `Could not reach Jellyfin: ${(err as Error).message}`,
        );
      }
      if (!enabled) {
        throw new Error(
          'Quick Connect is disabled on this server. Enable it in the Jellyfin dashboard ' +
            '(Settings → General → Quick Connect) or connect with an API key instead.',
        );
      }
      return qcClient.quickConnectInitiate();
    });

    session.setHandler('qc_poll', async (payload: { secret: string }) => {
      if (!qcClient) throw new Error('Start Quick Connect first');
      if (!payload?.secret) throw new Error('Missing Quick Connect secret');
      const approved = await qcClient.quickConnectState(payload.secret);
      if (!approved) return { authenticated: false };

      const auth = await qcClient.authenticateWithQuickConnect(payload.secret);
      // Validate the token like the API-key path. A non-admin account cannot
      // list /Users, so the authenticated user doubles as the only choice.
      const probed = await probeServer(
        this.homey,
        app.manifest?.version ?? '0.0.0',
        qcBaseUrl,
        auth.accessToken,
        {
          insecureTls: qcInsecureTls,
          fallbackUser: { Id: auth.userId, Name: auth.userName },
        },
      );
      if (expectedDataId && `server:${probed.serverId}` !== expectedDataId) {
        throw new Error(
          'Repair target mismatch: that Quick Connect login points to a different Jellyfin server. ' +
            'Add a new server device instead.',
        );
      }
      setState(probed);
      this.log('quick connect OK', probed.serverName, `as ${auth.userName}`);
      return {
        authenticated: true,
        server: probed.serverName,
        users: probed.users,
        authUserId: auth.userId,
      };
    });
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let state: PairState | null = null;

    this.registerQuickConnectHandlers(session, (s) => {
      state = s;
    });

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
        // Quick Connect knows the TLS choice up front; the API-key path keeps
        // the setting's default.
        ...(effective.insecureTls !== undefined
          ? { settings: { insecureTls: effective.insecureTls } }
          : {}),
      };
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let state: PairState | null = null;

    this.registerQuickConnectHandlers(
      session,
      (s) => {
        state = s;
      },
      device.getData().id,
    );

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
      // insecureTls is only known on the Quick-Connect path; leave the
      // existing setting untouched on an API-key repair.
      const tlsPatch =
        effective.insecureTls !== undefined ? { insecureTls: effective.insecureTls } : {};
      await device
        .setSettings({
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          userName: user.Name,
          ...tlsPatch,
        })
        .catch(() => undefined);

      // Programmatic setSettings() does NOT fire onSettings, so tell the
      // device to tear down and rebuild its hub with the new credentials —
      // releasing the hub alone would leave the device dead until app restart.
      await (device as JellyfinServerDevice).rebuildHub({
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        userName: user.Name,
        ...tlsPatch,
      });
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
