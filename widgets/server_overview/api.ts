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
  /** Poster cache key (`itemId:imageTag`); '' when the stream has no item. */
  posterKey: string;
  /** Omitted when the frontend already holds this poster (see `have`). */
  posterDataUri?: string;
}

// Resource cap: encode posters for at most the first 8 streams per response —
// the remaining rows render the initials fallback so busy servers stay cheap.
const POSTER_STREAM_CAP = 8;

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
  if (requestedId) {
    const match = servers.find((s) => s.id === requestedId);
    // A stale (unpaired) server id must surface as an error, not silently show
    // another server's data — the frontend resets its stored selection on it.
    if (!match) throw new Error(`Unknown server: ${requestedId}`);
    return match;
  }
  return servers[0] || null;
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
    posterKey: item?.Id ? `${item.Id}:${item.ImageTags?.Primary ?? ''}` : '',
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
    const server = selectServer(homey, query?.serverId);

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
    // Poster keys (`itemId:imageTag`) the frontend already caches — no need to
    // re-encode and re-ship those (posters only travel once per item version).
    const have = new Set((query?.have ?? '').split(',').filter(Boolean));
    const snaps = await hub.getActiveStreams();
    const streams: OverviewStream[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const stream = snapshotToStream(snaps[i]);
      if (i >= POSTER_STREAM_CAP) {
        stream.posterDataUri = '';
      } else if (!stream.posterKey || !have.has(stream.posterKey)) {
        stream.posterDataUri = await posterFor(hub, snaps[i]);
      }
      streams.push(stream);
    }
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
