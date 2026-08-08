import type HomeyfinApp from '../../app';
import type { LatestListEntry, ResumeListEntry } from '../../lib/ServerHub';

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

interface GridItem {
  id: string;
  name: string;
  type: string;
  seriesName?: string;
  progressPercent?: number;
  /** Poster image tag — part of the frontend's cache key (`id:imageTag`). */
  imageTag?: string;
  /** Omitted when the frontend already holds this item's poster (see `have`). */
  posterDataUri?: string;
}

// Resource caps: at most 20 small posters per response, rendered at 240 px.
const POSTER_MAX_WIDTH = 240;
const LATEST_CAP = 20;
const RESUME_CAP = 12;

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

module.exports = {
  async getServers({ homey }: ApiArgs) {
    return listServerDevices(homey);
  },

  async getItems({ homey, query }: ApiArgs) {
    const app = homey.app as HomeyfinApp;
    const server = selectServer(homey, query?.serverId);
    if (!server) return { server: null, online: false, items: [] };
    const hub = app.getHub(server.id);
    if (!hub) return { server, online: false, items: [] };

    const online = hub.isSocketOpen();
    const tab = query?.tab === 'resume' ? 'resume' : 'latest';
    // Poster keys (`id:imageTag`) the frontend already caches — no need to
    // re-encode and re-ship those (posters only travel once per item version).
    const have = new Set((query?.have ?? '').split(',').filter(Boolean));

    let entries: Array<LatestListEntry | ResumeListEntry>;
    if (tab === 'resume') {
      try {
        entries = await hub.getResumeList(RESUME_CAP);
      } catch {
        entries = [];
      }
    } else {
      entries = hub.getLatestList().slice(0, LATEST_CAP);
    }

    const items: GridItem[] = [];
    for (const entry of entries) {
      const item: GridItem = { id: entry.id, name: entry.name, type: entry.type };
      if (entry.seriesName) item.seriesName = entry.seriesName;
      const pct = (entry as ResumeListEntry).progressPercent;
      if (typeof pct === 'number') item.progressPercent = pct;
      if (entry.imageTag) item.imageTag = entry.imageTag;
      // Keyed on id AND image tag so changed artwork is re-shipped.
      if (!have.has(`${entry.id}:${entry.imageTag ?? ''}`)) {
        // Poster is fetched server-side (authenticated, LRU-cached) and delivered
        // as a data: URI so no api_key ever reaches the dashboard webview.
        item.posterDataUri = (await hub.getPosterDataUri(entry.id, entry.imageTag, POSTER_MAX_WIDTH)) ?? '';
      }
      items.push(item);
    }
    return { server, online, items };
  },

  async getSessions({ homey, query }: ApiArgs) {
    const app = homey.app as HomeyfinApp;
    const server = selectServer(homey, query?.serverId);
    if (!server) return [];
    const hub = app.getHub(server.id);
    if (!hub) return [];
    try {
      return await hub.getControllableSessions();
    } catch {
      return [];
    }
  },

  async play({ homey, body }: ApiArgs) {
    const app = homey.app as HomeyfinApp;
    const server = selectServer(homey, body?.serverId as string | undefined);
    if (!server) throw new Error('No server');
    const hub = app.getHub(server.id);
    if (!hub) throw new Error('Hub not connected');

    const itemId = String(body?.itemId ?? '');
    const sessionId = String(body?.sessionId ?? '');
    if (!itemId || !sessionId) throw new Error('itemId and sessionId required');
    await hub.client.playItemsOnSession(sessionId, [itemId], { playCommand: 'PlayNow' });
    return { ok: true };
  },
};
