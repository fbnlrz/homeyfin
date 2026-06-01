import type HomeyfinApp from '../../app';
import type { ClientSnapshot } from '../../lib/ServerHub';

type HomeyRef = HomeyfinApp['homey'];

interface ApiArgs {
  homey: HomeyRef;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

interface ServerSummary {
  id: string;
  name: string;
  baseUrl: string;
}

interface OverviewStream {
  deviceName: string;
  clientName: string;
  userName: string;
  title: string;
  subtitle: string;
  isPaused: boolean;
  positionSeconds: number;
  durationSeconds: number;
  posterUrl: string;
}

function listServerDevices(homey: HomeyRef): ServerSummary[] {
  const driver = homey.drivers.getDriver('server');
  return driver.getDevices().map((d: any) => {
    const id = d.getData().id.replace(/^server:/, '');
    const store = d.getStore() as { baseUrl: string };
    return { id, name: d.getName(), baseUrl: store.baseUrl };
  });
}

function selectServer(homey: HomeyRef, requestedId?: string): ServerSummary | null {
  const servers = listServerDevices(homey);
  return (requestedId && servers.find((s) => s.id === requestedId)) || servers[0] || null;
}

function snapshotToStream(snap: ClientSnapshot): OverviewStream {
  let title = '';
  let subtitle = '';
  const item = snap.nowPlaying;
  if (item) {
    if (item.Type === 'Episode' && item.SeriesName) {
      title = item.SeriesName;
      const s = item.ParentIndexNumber ?? 0;
      const e = item.IndexNumber ?? 0;
      subtitle = `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')} · ${item.Name ?? ''}`;
    } else {
      title = item.Name ?? '';
      subtitle = item.Type ?? '';
    }
  }
  return {
    deviceName: snap.deviceName ?? '',
    clientName: snap.clientName ?? '',
    userName: snap.userName ?? '',
    title,
    subtitle,
    isPaused: snap.isPaused,
    positionSeconds: snap.positionSeconds ?? 0,
    durationSeconds: snap.durationSeconds ?? 0,
    posterUrl: snap.posterUrl ?? '',
  };
}

module.exports = {
  async getNowPlaying({ homey, query }: ApiArgs) {
    const app = homey.app as HomeyfinApp;
    const server = selectServer(homey, query?.serverId);
    if (!server) return { hasStream: false };
    const hub = app.getHub(server.id);
    if (!hub) return { hasStream: false, server };

    let snap: ClientSnapshot | undefined;
    if (query?.deviceId) {
      snap = hub.getClientSnapshot(query.deviceId);
    } else {
      const streams = await hub.getActiveStreams();
      snap = streams[0];
    }
    if (!snap || !snap.nowPlaying) return { hasStream: false, server };
    return { hasStream: true, server, stream: snapshotToStream(snap) };
  },

  async togglePlayback({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.sessionId) throw new Error('No active session');
    await hub.client.sendPlaystate(snap.sessionId, snap.isPaused ? 'Unpause' : 'Pause');
    return { ok: true };
  },

  async skipSeconds({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.sessionId) throw new Error('No active session');
    const delta = Number(body?.seconds ?? 0);
    const current = snap.positionSeconds ?? 0;
    const duration = snap.durationSeconds ?? 0;
    const target = Math.max(
      0,
      duration > 0 ? Math.min(duration, current + delta) : current + delta,
    );
    await hub.client.seekToSeconds(snap.sessionId, target);
    return { ok: true, position: target };
  },

  async skipChapter({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.sessionId || !snap.nowPlaying?.Id) throw new Error('No active session');
    if (!snap.userId) throw new Error('Session has no user id');

    const direction = (body?.direction as string) ?? 'next';
    const full = await hub.client.getItem(snap.userId, snap.nowPlaying.Id, 'Chapters');
    const chapters = (full.Chapters ?? []).map((c) => c.StartPositionTicks);
    if (chapters.length === 0) throw new Error('No chapter data');
    const ticks = (snap.positionSeconds ?? 0) * 10_000_000;
    let target: number | undefined;
    if (direction === 'next') {
      target = chapters.find((t) => t > ticks + 1_000_000);
    } else {
      const grace = 5 * 10_000_000;
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (chapters[i] < ticks - grace) {
          target = chapters[i];
          break;
        }
      }
      if (target === undefined && chapters.length > 0) target = chapters[0];
    }
    if (target === undefined) throw new Error('No chapter in that direction');
    await hub.client.seekToSeconds(snap.sessionId, target / 10_000_000);
    return { ok: true };
  },

  async seekTo({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.sessionId) throw new Error('No active session');
    const seconds = Math.max(0, Number(body?.seconds ?? 0));
    await hub.client.seekToSeconds(snap.sessionId, seconds);
    return { ok: true };
  },

  async markWatched({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.userId || !snap.nowPlaying?.Id) throw new Error('No active item');
    await hub.client.setPlayed(snap.userId, snap.nowPlaying.Id, true);
    return { ok: true };
  },

  async toggleFavorite({ homey, body }: ApiArgs) {
    const hub = await resolveHub(homey, body?.serverId as string | undefined);
    const snap = await resolveSnap(hub, body?.deviceId as string | undefined);
    if (!snap?.userId || !snap.nowPlaying?.Id) throw new Error('No active item');
    const full = await hub.client.getItem(snap.userId, snap.nowPlaying.Id, 'UserData');
    const fav = full.UserData?.IsFavorite === true;
    await hub.client.setFavorite(snap.userId, snap.nowPlaying.Id, !fav);
    return { ok: true, favorite: !fav };
  },
};

async function resolveHub(homey: HomeyRef, serverId?: string) {
  const app = homey.app as HomeyfinApp;
  const server = selectServer(homey, serverId);
  if (!server) throw new Error('No server');
  const hub = app.getHub(server.id);
  if (!hub) throw new Error('Hub not connected');
  return hub;
}

async function resolveSnap(
  hub: Awaited<ReturnType<typeof resolveHub>>,
  deviceId?: string,
): Promise<ClientSnapshot | undefined> {
  if (deviceId) return hub.getClientSnapshot(deviceId);
  const streams = await hub.getActiveStreams();
  return streams[0];
}
