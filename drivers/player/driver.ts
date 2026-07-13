import Homey from 'homey';
import type HomeyfinApp from '../../app';

interface PlayerListDevice {
  name: string;
  data: { id: string };
  store: {
    serverId: string;
    deviceId: string;
    userId: string;
    userName: string;
    deviceName: string;
    clientName: string;
  };
}

interface Tuple {
  deviceId: string;
  deviceName: string;
  clientName: string;
  userId: string;
  userName: string;
}

export default class JellyfinPlayerDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Player driver init');
  }

  /**
   * Homey's list_devices template calls this. We aggregate the clients of every
   * paired Jellyfin server: known devices (with their last user) plus whatever
   * is playing right now, one entry per (client, user). Already-paired players
   * are filtered out.
   */
  async onPairListDevices(): Promise<PlayerListDevice[]> {
    const app = this.homey.app as HomeyfinApp;
    const serverDriver = this.homey.drivers.getDriver('server');
    const servers = serverDriver.getDevices().map((d: Homey.Device) => ({
      id: d.getData().id.replace(/^server:/, ''),
      name: d.getName(),
    }));

    const existing = new Set(this.getDevices().map((d: Homey.Device) => d.getData().id as string));
    const out: PlayerListDevice[] = [];

    for (const server of servers) {
      const hub = app.getHub(server.id);
      if (!hub) continue;

      // Map user names -> ids so /Devices' LastUserName can be resolved.
      const nameToId = new Map<string, string>();
      try {
        for (const u of await hub.client.getUsers()) nameToId.set(u.Name, u.Id);
      } catch (err) {
        this.error('getUsers during pairing failed', (err as Error).message);
      }

      const tuples = new Map<string, Tuple>();

      // Known devices (needs an admin key; degrade gracefully if forbidden).
      try {
        const devices = await hub.client.getDevices();
        for (const d of devices.Items) {
          const userName = d.LastUserName ?? '';
          const userId = nameToId.get(userName);
          if (!userId) continue;
          tuples.set(`${d.Id}:${userId}`, {
            deviceId: d.Id,
            deviceName: d.Name,
            clientName: d.AppName ?? '',
            userId,
            userName,
          });
        }
      } catch (err) {
        this.log('getDevices unavailable (non-admin key?), using sessions only');
      }

      // Currently-active sessions give the most accurate current user + ids.
      try {
        for (const s of await hub.client.getSessions()) {
          if (!s.DeviceId || !s.UserId) continue;
          tuples.set(`${s.DeviceId}:${s.UserId}`, {
            deviceId: s.DeviceId,
            deviceName: s.DeviceName,
            clientName: s.Client,
            userId: s.UserId,
            userName: s.UserName ?? '',
          });
        }
      } catch (err) {
        this.error('getSessions during pairing failed', (err as Error).message);
      }

      const multiServer = servers.length > 1;
      for (const t of tuples.values()) {
        const id = `${server.id}:${t.deviceId}:${t.userId}`;
        if (existing.has(id)) continue;
        const label = t.deviceName || t.clientName || 'Player';
        const user = t.userName || 'Unknown';
        const serverTag = multiServer ? ` (${server.name})` : '';
        out.push({
          name: `${label} — ${user}${serverTag}`,
          data: { id },
          store: {
            serverId: server.id,
            deviceId: t.deviceId,
            userId: t.userId,
            userName: t.userName,
            deviceName: t.deviceName,
            clientName: t.clientName,
          },
        });
      }
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = JellyfinPlayerDriver;
