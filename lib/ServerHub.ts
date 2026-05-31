import { EventEmitter } from 'events';
import {
  ItemCounts,
  JellyfinClient,
  JellyfinSession,
  LatestItem,
  NowPlayingItem,
} from './JellyfinClient';
import { JellyfinSocket } from './JellyfinSocket';

export interface ServerHubOptions {
  baseUrl: string;
  apiKey: string;
  serverId: string;
  userId: string;
  homeyDeviceId: string;
  appVersion: string;
  debug?: boolean;
}

export interface ClientSnapshot {
  deviceId: string;
  sessionId: string;
  clientName: string;
  deviceName: string;
  userName?: string;
  online: boolean;
  isPaused: boolean;
  isMuted: boolean;
  volumeLevel?: number;
  positionSeconds?: number;
  durationSeconds?: number;
  nowPlaying?: NowPlayingItem;
}

export interface NewItemEvent {
  item: LatestItem;
  libraryName: string;
  posterUrl?: string;
}

const TICKS_PER_SECOND = 10_000_000;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Holds a single connection to a Jellyfin server and translates raw events
 * into per-client and per-library events that Homey devices subscribe to.
 *
 * Events (typed loosely as the EventEmitter contract):
 *  - `client:<deviceId>:update`         (snapshot: ClientSnapshot)
 *  - `client:<deviceId>:playback_started`  (snapshot, item)
 *  - `client:<deviceId>:playback_paused`   (snapshot, item)
 *  - `client:<deviceId>:playback_resumed`  (snapshot, item)
 *  - `client:<deviceId>:playback_stopped`  (snapshot, lastItem)
 *  - `client:<deviceId>:now_playing_changed` (snapshot, item)
 *  - `library:counts` (counts)
 *  - `library:new_item` (NewItemEvent)
 *  - `library:scan_finished` (durationSeconds)
 *  - `user:logged_in` ({ user, client, deviceName })
 */
export class ServerHub extends EventEmitter {
  readonly client: JellyfinClient;
  private socket: JellyfinSocket;

  private lastSnapshots = new Map<string, ClientSnapshot>();
  private lastItemIds = new Set<string>();
  private bootstrapped = false;
  private lastCounts?: ItemCounts;
  private pollTimer?: NodeJS.Timeout;
  private scanStartedAt?: number;
  private knownSessionKeys = new Set<string>();

  constructor(private readonly opts: ServerHubOptions) {
    super();
    this.setMaxListeners(50);

    this.client = new JellyfinClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      deviceId: opts.homeyDeviceId,
      deviceName: 'Homey',
      clientName: 'Homeyfin',
      appVersion: opts.appVersion,
    });

    this.socket = new JellyfinSocket({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      deviceId: opts.homeyDeviceId,
      debug: opts.debug,
    });

    this.socket.on('sessions', (data) => this.handleSessions(data as JellyfinSession[]));
    this.socket.on('libraryChanged', () => {
      this.refreshLibrary().catch((err) => this.emit('error', err));
    });
    this.socket.on('scheduledTaskEnded', (data) => this.handleScheduledTask(data));
    this.socket.on('activityLogEntry', (entries) => this.handleActivityLog(entries));
    this.socket.on('error', (err) => {
      if (opts.debug) console.log('[ServerHub] socket error', err.message);
    });
  }

  get serverId(): string {
    return this.opts.serverId;
  }

  get userId(): string {
    return this.opts.userId;
  }

  async start(): Promise<void> {
    this.socket.start();
    await this.refreshLibrary().catch((err) => {
      if (this.opts.debug) console.log('[ServerHub] initial refresh failed', err);
    });
    this.pollTimer = setInterval(() => {
      this.refreshLibrary().catch(() => undefined);
      this.pollSessions().catch(() => undefined);
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.socket.stop();
    this.removeAllListeners();
  }

  /** Returns the most recent snapshot for a Jellyfin client deviceId, if any. */
  getClientSnapshot(deviceId: string): ClientSnapshot | undefined {
    return this.lastSnapshots.get(deviceId);
  }

  // --- Sessions handling -------------------------------------------------

  private async pollSessions(): Promise<void> {
    try {
      const sessions = await this.client.getSessions();
      this.handleSessions(sessions);
    } catch (err) {
      if (this.opts.debug) console.log('[ServerHub] pollSessions failed', err);
    }
  }

  private handleSessions(sessions: JellyfinSession[]): void {
    const seenDeviceIds = new Set<string>();
    const seenSessionKeys = new Set<string>();

    for (const s of sessions) {
      if (!s.DeviceId) continue;
      seenDeviceIds.add(s.DeviceId);

      const sessionKey = `${s.DeviceId}:${s.UserId ?? 'anon'}`;
      seenSessionKeys.add(sessionKey);
      if (!this.knownSessionKeys.has(sessionKey) && s.UserName) {
        this.emit('user:logged_in', {
          user: s.UserName,
          client: s.Client,
          deviceName: s.DeviceName,
        });
      }

      const snapshot = this.toSnapshot(s);
      const prev = this.lastSnapshots.get(s.DeviceId);
      this.lastSnapshots.set(s.DeviceId, snapshot);
      this.emit(`client:${s.DeviceId}:update`, snapshot);

      this.detectPlaybackTransitions(prev, snapshot);
    }

    // Sessions that disappeared → emit stopped/offline.
    for (const [deviceId, prev] of this.lastSnapshots) {
      if (seenDeviceIds.has(deviceId)) continue;
      if (!prev.online && !prev.nowPlaying) continue;
      const offline: ClientSnapshot = { ...prev, online: false, nowPlaying: undefined, isPaused: false };
      this.lastSnapshots.set(deviceId, offline);
      this.emit(`client:${deviceId}:update`, offline);
      if (prev.nowPlaying) {
        this.emit(`client:${deviceId}:playback_stopped`, offline, prev.nowPlaying);
      }
    }

    this.knownSessionKeys = seenSessionKeys;
  }

  private toSnapshot(s: JellyfinSession): ClientSnapshot {
    const ps = s.PlayState ?? {};
    return {
      deviceId: s.DeviceId,
      sessionId: s.Id,
      clientName: s.Client,
      deviceName: s.DeviceName,
      userName: s.UserName,
      online: true,
      isPaused: ps.IsPaused === true,
      isMuted: ps.IsMuted === true,
      volumeLevel: typeof ps.VolumeLevel === 'number' ? ps.VolumeLevel : undefined,
      positionSeconds:
        typeof ps.PositionTicks === 'number' ? Math.round(ps.PositionTicks / TICKS_PER_SECOND) : undefined,
      durationSeconds:
        typeof s.NowPlayingItem?.RunTimeTicks === 'number'
          ? Math.round(s.NowPlayingItem.RunTimeTicks / TICKS_PER_SECOND)
          : undefined,
      nowPlaying: s.NowPlayingItem,
    };
  }

  private detectPlaybackTransitions(prev: ClientSnapshot | undefined, next: ClientSnapshot): void {
    const ch = `client:${next.deviceId}`;

    const prevItem = prev?.nowPlaying;
    const nextItem = next.nowPlaying;

    // Started: nothing playing before → something now.
    if (!prevItem && nextItem) {
      this.emit(`${ch}:playback_started`, next, nextItem);
      this.emit(`${ch}:now_playing_changed`, next, nextItem);
      return;
    }

    // Stopped: something playing before → nothing now.
    if (prevItem && !nextItem) {
      this.emit(`${ch}:playback_stopped`, next, prevItem);
      return;
    }

    if (prevItem && nextItem) {
      // Item changed (next episode etc.)
      if (prevItem.Id !== nextItem.Id) {
        this.emit(`${ch}:now_playing_changed`, next, nextItem);
        this.emit(`${ch}:playback_started`, next, nextItem);
      }
      // Pause / resume
      if (prev && prev.isPaused !== next.isPaused) {
        if (next.isPaused) this.emit(`${ch}:playback_paused`, next, nextItem);
        else this.emit(`${ch}:playback_resumed`, next, nextItem);
      }
    }
  }

  // --- Library handling --------------------------------------------------

  private async refreshLibrary(): Promise<void> {
    try {
      const [counts, latest, folders] = await Promise.all([
        this.client.getItemCounts(this.opts.userId).catch(() => undefined),
        this.client.getLatestItems({ userId: this.opts.userId, limit: 30 }).catch(() => []),
        this.client.getMediaFolders().catch(() => ({ Items: [] as { Id: string; Name: string }[] })),
      ]);

      if (counts) {
        this.lastCounts = counts;
        this.emit('library:counts', counts);
      }

      const folderById = new Map(folders.Items.map((f) => [f.Id, f.Name]));

      const currentIds = new Set(latest.map((i) => i.Id));
      if (this.bootstrapped) {
        for (const item of latest) {
          if (!this.lastItemIds.has(item.Id)) {
            this.emit('library:new_item', {
              item,
              libraryName: item.ParentId ? folderById.get(item.ParentId) ?? '' : '',
              posterUrl: item.ImageTags?.Primary
                ? this.client.imageUrl(item.Id, 'Primary', item.ImageTags.Primary)
                : undefined,
            } as NewItemEvent);
          }
        }
      }
      this.lastItemIds = currentIds;
      this.bootstrapped = true;
    } catch (err) {
      if (this.opts.debug) console.log('[ServerHub] refreshLibrary failed', err);
    }
  }

  private handleScheduledTask(data: unknown): void {
    const entry = data as { Key?: string; Status?: string; StartTimeUtc?: string; EndTimeUtc?: string } | undefined;
    if (!entry) return;
    // Refresh-library scheduled task key is "RefreshLibrary".
    if (entry.Key && entry.Key.toLowerCase().includes('refreshlibrary')) {
      if (entry.StartTimeUtc && entry.EndTimeUtc) {
        const duration = Math.max(
          0,
          Math.round((Date.parse(entry.EndTimeUtc) - Date.parse(entry.StartTimeUtc)) / 1000),
        );
        this.emit('library:scan_finished', duration);
      } else if (this.scanStartedAt) {
        this.emit('library:scan_finished', Math.round((Date.now() - this.scanStartedAt) / 1000));
        this.scanStartedAt = undefined;
      } else {
        this.emit('library:scan_finished', 0);
      }
    }
  }

  private handleActivityLog(entries: unknown[]): void {
    for (const raw of entries) {
      const entry = raw as { Type?: string; UserId?: string; Name?: string; ShortOverview?: string } | undefined;
      if (!entry || !entry.Type) continue;
      // Jellyfin emits a "SessionStarted" or similar activity entry when a user logs in.
      // Real fan-out happens in handleSessions via knownSessionKeys diff; this hook is
      // reserved for future use (e.g. surface playback errors as Homey events).
    }
  }

  /** Marks a manual scan as started; helps compute duration on the resulting ScheduledTaskEnded. */
  markScanStarted(): void {
    this.scanStartedAt = Date.now();
  }

  getLastCounts(): ItemCounts | undefined {
    return this.lastCounts;
  }
}
