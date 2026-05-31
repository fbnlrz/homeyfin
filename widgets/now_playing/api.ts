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
    const app = homey.app as HomeyfinApp;
    const deviceId = (body?.deviceId as string | undefined) ?? '';
    const serverId = (body?.serverId as string | undefined) ?? '';
    const server = selectServer(homey, serverId);
    if (!server) throw new Error('No server');
    const hub = app.getHub(server.id);
    if (!hub) throw new Error('Hub not connected');

    let snap: ClientSnapshot | undefined;
    if (deviceId) {
      snap = hub.getClientSnapshot(deviceId);
    } else {
      const streams = await hub.getActiveStreams();
      snap = streams[0];
    }
    if (!snap?.sessionId) throw new Error('No active session');
    await hub.client.sendPlaystate(snap.sessionId, snap.isPaused ? 'Unpause' : 'Pause');
    return { ok: true };
  },
};
