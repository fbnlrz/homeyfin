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
    matchBy?: 'device' | 'app';
  };
}

interface Tuple {
  deviceId: string;
  deviceName: string;
  clientName: string;
  userId: string;
  userName: string;
  lastActivityMs?: number;
  online: boolean;
}

// Jellyfin mints a fresh DeviceId for every browser/profile, so /Devices fills
// up with dead clients over time. Hide anything not seen within this window
// (unless it has a live session right now) so the pairing list stays usable.
const STALE_AFTER_DAYS = 30;

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
    // _group 0 = Follow-App entries (shown first), 1 = fixed-device entries.
    const out: Array<PlayerListDevice & { _sortKey: number; _group: number }> = [];

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
          const lastActivityMs = d.DateLastActivity ? Date.parse(d.DateLastActivity) : undefined;
          tuples.set(`${d.Id}:${userId}`, {
            deviceId: d.Id,
            deviceName: d.Name,
            clientName: d.AppName ?? '',
            userId,
            userName,
            lastActivityMs: Number.isNaN(lastActivityMs) ? undefined : lastActivityMs,
            online: false,
          });
        }
      } catch (err) {
        this.log('getDevices unavailable (non-admin key?), using sessions only');
      }

      // Currently-active sessions give the most accurate current user + ids and
      // mark a client as online right now (so it survives the staleness filter).
      try {
        for (const s of await hub.client.getSessions()) {
          if (!s.DeviceId || !s.UserId) continue;
          const lastActivityMs = s.LastActivityDate ? Date.parse(s.LastActivityDate) : Date.now();
          tuples.set(`${s.DeviceId}:${s.UserId}`, {
            deviceId: s.DeviceId,
            deviceName: s.DeviceName,
            clientName: s.Client,
            userId: s.UserId,
            userName: s.UserName ?? '',
            lastActivityMs: Number.isNaN(lastActivityMs) ? Date.now() : lastActivityMs,
            online: true,
          });
        }
      } catch (err) {
        this.error('getSessions during pairing failed', (err as Error).message);
      }

      const now = Date.now();
      const staleCutoff = now - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      const multiServer = servers.length > 1;
      const serverTag = multiServer ? ` (${server.name})` : '';
      const isStale = (t: Pick<Tuple, 'online' | 'lastActivityMs'>): boolean =>
        !t.online && t.lastActivityMs !== undefined && t.lastActivityMs < staleCutoff;

      // Follow-App entries: one per (client app, user), collapsing every browser
      // DeviceId of that app into a single stable device that tracks the live
      // session. This is the antidote to the "hundreds of players" problem.
      const appMap = new Map<string, Tuple>();
      for (const t of tuples.values()) {
        if (!t.clientName) continue;
        const key = `${t.clientName}:${t.userId}`;
        const cur = appMap.get(key);
        const better =
          !cur ||
          (t.online && !cur.online) ||
          (t.online === cur.online && (t.lastActivityMs ?? 0) > (cur.lastActivityMs ?? 0));
        appMap.set(key, {
          clientName: t.clientName,
          userId: t.userId,
          userName: t.userName || cur?.userName || '',
          deviceName: better ? t.deviceName : cur?.deviceName ?? t.deviceName,
          deviceId: '',
          lastActivityMs: Math.max(t.lastActivityMs ?? 0, cur?.lastActivityMs ?? 0) || undefined,
          online: (cur?.online ?? false) || t.online,
        });
      }
      for (const a of appMap.values()) {
        const id = `${server.id}:app:${a.clientName}:${a.userId}`;
        if (existing.has(id) || isStale(a)) continue;
        const user = a.userName || 'Unknown';
        const seenTag = a.online ? ' · online' : '';
        out.push({
          _group: 0,
          _sortKey: a.online ? Number.MAX_SAFE_INTEGER : a.lastActivityMs ?? 0,
          name: `${a.clientName} — ${user}${serverTag} · follows app${seenTag}`,
          data: { id },
          store: {
            serverId: server.id,
            deviceId: '',
            userId: a.userId,
            userName: a.userName,
            deviceName: a.deviceName,
            clientName: a.clientName,
            matchBy: 'app',
          },
        });
      }

      // Fixed-device entries: one per exact (DeviceId, user), for pinning to a
      // specific client. Long-dead browser DeviceIds are hidden.
      for (const t of tuples.values()) {
        const id = `${server.id}:${t.deviceId}:${t.userId}`;
        if (existing.has(id) || isStale(t)) continue;

        const label = t.deviceName || t.clientName || 'Player';
        const user = t.userName || 'Unknown';
        const seenTag = JellyfinPlayerDriver.lastSeenTag(t, now);
        out.push({
          _group: 1,
          _sortKey: t.online ? Number.MAX_SAFE_INTEGER : t.lastActivityMs ?? 0,
          name: `${label} — ${user}${serverTag}${seenTag}`,
          data: { id },
          store: {
            serverId: server.id,
            deviceId: t.deviceId,
            userId: t.userId,
            userName: t.userName,
            deviceName: t.deviceName,
            clientName: t.clientName,
            matchBy: 'device',
          },
        });
      }
    }

    // Follow-App first, then most-recently-active (online on top), then
    // alphabetical; strip the internal sort helpers before returning.
    return out
      .sort(
        (a, b) =>
          a._group - b._group ||
          (b._sortKey ?? 0) - (a._sortKey ?? 0) ||
          a.name.localeCompare(b.name),
      )
      .map(({ _sortKey, _group, ...rest }) => rest);
  }

  /** Human-friendly "· online / · today / · 3d ago" suffix for the pairing label. */
  private static lastSeenTag(t: Tuple, now: number): string {
    if (t.online) return ' · online';
    if (t.lastActivityMs === undefined) return '';
    const days = Math.floor((now - t.lastActivityMs) / (24 * 60 * 60 * 1000));
    if (days <= 0) return ' · today';
    if (days === 1) return ' · 1d ago';
    return ` · ${days}d ago`;
  }
}

module.exports = JellyfinPlayerDriver;
