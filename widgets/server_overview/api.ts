import type HomeyfinApp from '../../app';
import type { ClientSnapshot, ServerHub } from '../../lib/ServerHub';

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
  isTranscoding: boolean;
  positionSeconds: number;
  durationSeconds: number;
  posterDataUri: string;
}

function listServerDevices(homey: HomeyRef): ServerSummary[] {
  const driver = homey.drivers.getDriver('server');
  return driver.getDevices().map((d: any) => {
    const id = d.getData().id.replace(/^server:/, '');
    const store = d.getStore() as { baseUrl: string };
    return { id, name: d.getName(), baseUrl: store.baseUrl };
  });
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
    isTranscoding: snap.isTranscoding === true,
    positionSeconds: snap.positionSeconds ?? 0,
    durationSeconds: snap.durationSeconds ?? 0,
    posterDataUri: '',
  };
}

// Poster is fetched server-side (authenticated, LRU-cached) and delivered as a
// data: URI so no api_key ever reaches the dashboard webview.
async function posterFor(hub: ServerHub, snap: ClientSnapshot): Promise<string> {
  const item = snap.nowPlaying;
  if (!item?.Id) return '';
  const uri = await hub.getPosterDataUri(item.Id, item.ImageTags?.Primary, 300);
  return uri ?? '';
}

module.exports = {
  async getServers({ homey }: ApiArgs) {
    return listServerDevices(homey);
  },

  async getOverview({ homey, query }: ApiArgs) {
    const app = homey.app as HomeyfinApp;
    const servers = listServerDevices(homey);
    const server = (query?.serverId && servers.find((s) => s.id === query.serverId)) || servers[0] || null;

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
    const snaps = await hub.getActiveStreams();
    const streams = await Promise.all(snaps.map(async (snap) => {
      const stream = snapshotToStream(snap);
      stream.posterDataUri = await posterFor(hub, snap);
      return stream;
    }));
    const active = streams.filter((s) => !s.isPaused).length;
    const paused = streams.filter((s) => s.isPaused).length;

    return {
      server,
      online: hub.isSocketOpen(),
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
