import Homey from 'homey';
import type HomeyfinApp from '../../app';

interface ServerOption {
  id: string;
  name: string;
  baseUrl: string;
}

interface UserListItem {
  Id: string;
  Name: string;
  IsAdministrator?: boolean;
  alreadyPaired?: boolean;
}

interface UserListDevice {
  name: string;
  data: { id: string };
  store: {
    serverId: string;
    userId: string;
    userName: string;
  };
}

export default class JellyfinUserDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('User driver init');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as HomeyfinApp;
    let selectedServerId: string | null = null;

    session.setHandler('list_servers', async (): Promise<ServerOption[]> => {
      const serverDriver = this.homey.drivers.getDriver('server');
      return serverDriver.getDevices().map((d: any) => {
        const store = d.getStore() as { baseUrl: string };
        const id = d.getData().id.replace(/^server:/, '');
        return { id, name: d.getName(), baseUrl: store.baseUrl };
      });
    });

    session.setHandler('server_selected', async (serverId: string) => {
      selectedServerId = serverId;
    });

    session.setHandler('fetch_users', async (): Promise<UserListItem[]> => {
      if (!selectedServerId) {
        const serverDriver = this.homey.drivers.getDriver('server');
        const first = serverDriver.getDevices()[0];
        if (!first) throw new Error('No paired Jellyfin server. Pair a server device first.');
        selectedServerId = first.getData().id.replace(/^server:/, '');
      }
      const serverId: string = selectedServerId as string;
      const hub = app.getHub(serverId);
      if (!hub) throw new Error('Server hub not initialised yet. Try again in a moment.');

      const users = await hub.client.getUsers();
      const existing = new Set(this.getDevices().map((d: any) => d.getData().id as string));
      return users.map((u) => ({
        Id: u.Id,
        Name: u.Name,
        IsAdministrator: u.IsAdministrator,
        alreadyPaired: existing.has(`${serverId}:${u.Id}`),
      }));
    });

    session.setHandler('add_user', async ({ userId }: { userId: string }): Promise<UserListDevice> => {
      if (!selectedServerId) throw new Error('No server selected');
      const serverId: string = selectedServerId;
      const hub = app.getHub(serverId);
      if (!hub) throw new Error('Server hub not initialised yet.');

      const users = await hub.client.getUsers();
      const user = users.find((u) => u.Id === userId);
      if (!user) throw new Error('User no longer present on server');

      return {
        name: `Jellyfin · ${user.Name}`,
        data: { id: `${serverId}:${user.Id}` },
        store: {
          serverId,
          userId: user.Id,
          userName: user.Name,
        },
      };
    });
  }
}

module.exports = JellyfinUserDriver;
