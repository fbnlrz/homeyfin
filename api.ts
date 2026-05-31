import type HomeyfinApp from './app';
import type { ClientSnapshot } from './lib/ServerHub';

type HomeyRef = HomeyfinApp['homey'];

interface ApiArgs {
  homey: HomeyRef;
  query?: Record<string, string>;
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

interface OverviewResponse {
  server: ServerSummary | null;
  online: boolean;
  counts: { movies: number; series: number; episodes: number };
  streams: OverviewStream[];
  activeCount: number;
  pausedCount: number;
}

function getApp(homey: HomeyRef): HomeyfinApp {
  return homey.app as HomeyfinApp;
}

function listServerDevices(homey: HomeyRef): Array<{ id: string; name: string; baseUrl: string }> {
  const driver = homey.drivers.getDriver('server');
  return driver.getDevices().map((d: any) => {
    const id = d.getData().id.replace(/^server:/, '');
    const store = d.getStore() as { baseUrl: string };
    return { id, name: d.getName(), baseUrl: store.baseUrl };
  });
}

function snapshotToStream(snap: ClientSnapshot, posterUrl: string): OverviewStream {
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
    posterUrl,
  };
}

module.exports = {
  async getServers({ homey }: ApiArgs): Promise<ServerSummary[]> {
    return listServerDevices(homey);
  },

  async getOverview({ homey, query }: ApiArgs): Promise<OverviewResponse> {
    const app = getApp(homey);
    const servers = listServerDevices(homey);
    const requestedId = query?.serverId;
    const server =
      (requestedId && servers.find((s) => s.id === requestedId)) || servers[0] || null;

    if (!server) {
      return {
        server: null,
        online: false,
        counts: { movies: 0, series: 0, episodes: 0 },
        streams: [],
        activeCount: 0,
        pausedCount: 0,
      };
    }

    const hub = app.getHub(server.id);
    if (!hub) {
      return {
        server,
        online: false,
        counts: { movies: 0, series: 0, episodes: 0 },
        streams: [],
        activeCount: 0,
        pausedCount: 0,
      };
    }

    const counts = hub.getLastCounts();
    const sessions = await hub.client.getSessions().catch(() => []);
    const streams: OverviewStream[] = [];
    let active = 0;
    let paused = 0;

    for (const s of sessions) {
      if (!s.NowPlayingItem) continue;
      const snap: ClientSnapshot = {
        deviceId: s.DeviceId,
        sessionId: s.Id,
        clientName: s.Client,
        deviceName: s.DeviceName,
        userName: s.UserName,
        online: true,
        isPaused: s.PlayState?.IsPaused === true,
        isMuted: s.PlayState?.IsMuted === true,
        volumeLevel: s.PlayState?.VolumeLevel,
        positionSeconds:
          typeof s.PlayState?.PositionTicks === 'number'
            ? Math.round(s.PlayState.PositionTicks / 10_000_000)
            : 0,
        durationSeconds:
          typeof s.NowPlayingItem.RunTimeTicks === 'number'
            ? Math.round(s.NowPlayingItem.RunTimeTicks / 10_000_000)
            : 0,
        nowPlaying: s.NowPlayingItem,
      };
      if (snap.isPaused) paused += 1;
      else active += 1;
      const posterUrl =
        s.NowPlayingItem.ImageTags?.Primary
          ? hub.client.imageUrl(s.NowPlayingItem.Id, 'Primary', s.NowPlayingItem.ImageTags.Primary, 300)
          : '';
      streams.push(snapshotToStream(snap, posterUrl));
    }

    return {
      server,
      online: true,
      counts: {
        movies: counts?.MovieCount ?? 0,
        series: counts?.SeriesCount ?? 0,
        episodes: counts?.EpisodeCount ?? 0,
      },
      streams,
      activeCount: active,
      pausedCount: paused,
    };
  },
};
