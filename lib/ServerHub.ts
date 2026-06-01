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
  insecureTls?: boolean;
  persistedItemIds?: string[];
  saveItemIds?: (ids: string[]) => void | Promise<void>;
  libraryPollMs?: number;
  fallbackPollMs?: number;
  activePollMs?: number;
}

export interface ClientSnapshot {
  deviceId: string;
  sessionId: string;
  clientName: string;
  deviceName: string;
  userId?: string;
  userName?: string;
  online: boolean;
  isPaused: boolean;
  isMuted: boolean;
  volumeLevel?: number;
  positionSeconds?: number;
  durationSeconds?: number;
  nowPlaying?: NowPlayingItem;
  posterUrl?: string;
  lastActivityMs?: number;
  isTranscoding: boolean;
  transcodeReasons?: string[];
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

export interface NewItemEvent {
  item: LatestItem;
  libraryName: string;
  posterUrl?: string;
}

const TICKS_PER_SECOND = 10_000_000;
const DEFAULT_LIBRARY_POLL_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_POLL_MS = 30 * 1000;
const DEFAULT_ACTIVE_POLL_MS = 5 * 1000;
const MAX_PERSISTED_IDS = 500;

/**
 * Holds a single connection to a Jellyfin server and translates raw events
 * into per-client and per-library events that Homey devices subscribe to.
 */
export class ServerHub extends EventEmitter {
  readonly client: JellyfinClient;
  private socket: JellyfinSocket;

  private lastSnapshots = new Map<string, ClientSnapshot>();
  private lastUserSnapshots = new Map<string, ClientSnapshot>();
  private lastItemIds = new Set<string>();
  private bootstrapped = false;
  private lastCounts?: ItemCounts;
  private libraryPollTimer?: NodeJS.Timeout;
  private sessionPollTimer?: NodeJS.Timeout;
  private currentPollMs?: number;
  private scanStartedAt?: number;
  private knownSessionKeys = new Set<string>();
  private socketOpen = false;
  private lastStreamCount = 0;
  private lastTranscodingCount = 0;

  private readonly libraryPollMs: number;
  private readonly fallbackPollMs: number;
  private readonly activePollMs: number;
  private readonly saveItemIds?: (ids: string[]) => void | Promise<void>;

  constructor(private readonly opts: ServerHubOptions) {
    super();
    this.setMaxListeners(50);

    this.libraryPollMs = opts.libraryPollMs ?? DEFAULT_LIBRARY_POLL_MS;
    this.fallbackPollMs = opts.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;
    this.activePollMs = opts.activePollMs ?? DEFAULT_ACTIVE_POLL_MS;
    this.saveItemIds = opts.saveItemIds;

    if (opts.persistedItemIds && opts.persistedItemIds.length > 0) {
      this.lastItemIds = new Set(opts.persistedItemIds);
      this.bootstrapped = true;
    }

    this.client = new JellyfinClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      deviceId: opts.homeyDeviceId,
      deviceName: 'Homey',
      clientName: 'Homeyfin',
      appVersion: opts.appVersion,
      insecureTls: opts.insecureTls,
    });

    this.socket = new JellyfinSocket({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      deviceId: opts.homeyDeviceId,
      debug: opts.debug,
    });

    this.socket.on('open', () => {
      const wasOpen = this.socketOpen;
      this.socketOpen = true;
      if (!wasOpen) this.emit('connection:up');
      this.adjustPolling();
    });
    this.socket.on('close', () => {
      const wasOpen = this.socketOpen;
      this.socketOpen = false;
      if (wasOpen) this.emit('connection:down');
      this.adjustPolling();
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

  isSocketOpen(): boolean {
    return this.socketOpen;
  }

  getStreamCount(): number {
    return this.lastStreamCount;
  }

  getTranscodingCount(): number {
    return this.lastTranscodingCount;
  }

  async start(): Promise<void> {
    this.socket.start();
    await this.refreshLibrary().catch((err) => {
      if (this.opts.debug) console.log('[ServerHub] initial refresh failed', err);
    });
    this.libraryPollTimer = setInterval(() => {
      this.refreshLibrary().catch(() => undefined);
    }, this.libraryPollMs);
    this.adjustPolling();
  }

  async stop(): Promise<void> {
    if (this.libraryPollTimer) {
      clearInterval(this.libraryPollTimer);
      this.libraryPollTimer = undefined;
    }
    this.stopSessionPoll();
    this.socket.stop();
    this.removeAllListeners();
  }

  /** Returns the most recent snapshot for a Jellyfin client deviceId, if any. */
  getClientSnapshot(deviceId: string): ClientSnapshot | undefined {
    return this.lastSnapshots.get(deviceId);
  }

  /**
   * Returns the most recent "active" snapshot for a Jellyfin user — the
   * session with NowPlayingItem; if none, the most-recently-active one.
   * Used by user-device drivers.
   */
  getUserSnapshot(userId: string): ClientSnapshot | undefined {
    return this.lastUserSnapshots.get(userId);
  }

  /** Picks the most active snapshot for a user from a list of candidates. */
  static pickActiveSnapshot(snaps: ClientSnapshot[]): ClientSnapshot | undefined {
    if (snaps.length === 0) return undefined;
    return [...snaps].sort((a, b) => {
      const aHas = a.nowPlaying ? 1 : 0;
      const bHas = b.nowPlaying ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const aOnline = a.online ? 1 : 0;
      const bOnline = b.online ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
    })[0];
  }

  // --- Smart session polling --------------------------------------------
  //
  // - Socket up + idle  : no extra polling (socket pushes Sessions frames).
  // - Socket up + active: poll every activePollMs (latency-bridge alongside
  //                       socket, smoother position ticker on the device).
  // - Socket down       : poll every fallbackPollMs.

  private adjustPolling(): void {
    const hasActive = this.lastStreamCount > 0;
    let desiredMs: number | undefined;
    if (!this.socketOpen) desiredMs = this.fallbackPollMs;
    else if (hasActive) desiredMs = this.activePollMs;
    else desiredMs = undefined;

    if (desiredMs === this.currentPollMs) return;
    this.stopSessionPoll();
    if (desiredMs) {
      this.currentPollMs = desiredMs;
      this.sessionPollTimer = setInterval(
        () => this.pollSessions().catch(() => undefined),
        desiredMs,
      );
    }
  }

  private stopSessionPoll(): void {
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = undefined;
    }
    this.currentPollMs = undefined;
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

  /**
   * Pure diff function — `prev` and `next` snapshot maps in, list of events
   * to emit out. Kept static for testability.
   */
  static diffSessions(
    prev: Map<string, ClientSnapshot>,
    next: Map<string, ClientSnapshot>,
  ): Array<{ deviceId: string; type: 'started' | 'paused' | 'resumed' | 'stopped' | 'changed' }> {
    const out: Array<{
      deviceId: string;
      type: 'started' | 'paused' | 'resumed' | 'stopped' | 'changed';
    }> = [];

    for (const [deviceId, nx] of next) {
      const pv = prev.get(deviceId);
      const prevItem = pv?.nowPlaying;
      const nextItem = nx.nowPlaying;

      if (!prevItem && nextItem) {
        out.push({ deviceId, type: 'started' });
        out.push({ deviceId, type: 'changed' });
        continue;
      }
      if (prevItem && !nextItem && nx.online) {
        out.push({ deviceId, type: 'stopped' });
        continue;
      }
      if (prevItem && nextItem) {
        if (prevItem.Id !== nextItem.Id) {
          out.push({ deviceId, type: 'changed' });
          out.push({ deviceId, type: 'started' });
        }
        if (pv && pv.isPaused !== nx.isPaused) {
          out.push({ deviceId, type: nx.isPaused ? 'paused' : 'resumed' });
        }
      }
    }
    for (const [deviceId, pv] of prev) {
      if (!next.has(deviceId) && pv.nowPlaying) {
        out.push({ deviceId, type: 'stopped' });
      }
    }
    return out;
  }

  private handleSessions(sessions: JellyfinSession[]): void {
    const seenDeviceIds = new Set<string>();
    const seenSessionKeys = new Set<string>();
    const nextMap = new Map<string, ClientSnapshot>();

    for (const s of sessions) {
      if (!s.DeviceId) continue;
      seenDeviceIds.add(s.DeviceId);

      const sessionKey = `${s.DeviceId}:${s.UserId ?? 'anon'}`;
      seenSessionKeys.add(sessionKey);
      if (!this.knownSessionKeys.has(sessionKey) && s.UserName) {
        this.emit('user:logged_in', {
          user: s.UserName,
          userId: s.UserId,
          client: s.Client,
          deviceName: s.DeviceName,
        });
      }

      const snapshot = this.toSnapshot(s);
      nextMap.set(s.DeviceId, snapshot);
    }

    // Devices that disappeared keep their last snapshot but become offline.
    for (const [deviceId, prev] of this.lastSnapshots) {
      if (seenDeviceIds.has(deviceId)) continue;
      const offline: ClientSnapshot = {
        ...prev,
        online: false,
        isPaused: false,
        nowPlaying: undefined,
      };
      nextMap.set(deviceId, offline);
    }

    const events = ServerHub.diffSessions(this.lastSnapshots, nextMap);

    for (const [deviceId, snap] of nextMap) {
      this.lastSnapshots.set(deviceId, snap);
      this.emit(`client:${deviceId}:update`, snap);
    }

    for (const ev of events) {
      const snap = nextMap.get(ev.deviceId);
      if (!snap) continue;
      const item = snap.nowPlaying ?? this.lastSnapshots.get(ev.deviceId)?.nowPlaying;
      switch (ev.type) {
        case 'started':
          if (item) this.emit(`client:${ev.deviceId}:playback_started`, snap, item);
          break;
        case 'paused':
          if (item) this.emit(`client:${ev.deviceId}:playback_paused`, snap, item);
          break;
        case 'resumed':
          if (item) this.emit(`client:${ev.deviceId}:playback_resumed`, snap, item);
          break;
        case 'stopped':
          this.emit(`client:${ev.deviceId}:playback_stopped`, snap, item);
          break;
        case 'changed':
          if (item) this.emit(`client:${ev.deviceId}:now_playing_changed`, snap, item);
          break;
      }
    }

    // Build per-user "active" snapshot map and diff it the same way.
    const byUser = new Map<string, ClientSnapshot[]>();
    for (const snap of nextMap.values()) {
      if (!snap.userId) continue;
      const list = byUser.get(snap.userId) ?? [];
      list.push(snap);
      byUser.set(snap.userId, list);
    }
    const nextUserMap = new Map<string, ClientSnapshot>();
    for (const [userId, list] of byUser) {
      const active = ServerHub.pickActiveSnapshot(list);
      if (active) nextUserMap.set(userId, active);
    }
    // Users that disappeared: keep their last snapshot but mark offline so the diff
    // emits a stopped event exactly once.
    for (const [userId, prev] of this.lastUserSnapshots) {
      if (nextUserMap.has(userId)) continue;
      const offline: ClientSnapshot = {
        ...prev,
        online: false,
        isPaused: false,
        nowPlaying: undefined,
      };
      nextUserMap.set(userId, offline);
    }

    const userEvents = ServerHub.diffSessions(this.lastUserSnapshots, nextUserMap);
    for (const [userId, snap] of nextUserMap) {
      this.lastUserSnapshots.set(userId, snap);
      this.emit(`user:${userId}:update`, snap);
    }
    for (const ev of userEvents) {
      const snap = nextUserMap.get(ev.deviceId); // deviceId field reused for the key
      if (!snap) continue;
      const item = snap.nowPlaying ?? this.lastUserSnapshots.get(ev.deviceId)?.nowPlaying;
      switch (ev.type) {
        case 'started':
          if (item) this.emit(`user:${ev.deviceId}:playback_started`, snap, item);
          break;
        case 'paused':
          if (item) this.emit(`user:${ev.deviceId}:playback_paused`, snap, item);
          break;
        case 'resumed':
          if (item) this.emit(`user:${ev.deviceId}:playback_resumed`, snap, item);
          break;
        case 'stopped':
          this.emit(`user:${ev.deviceId}:playback_stopped`, snap, item);
          break;
        case 'changed':
          if (item) this.emit(`user:${ev.deviceId}:now_playing_changed`, snap, item);
          break;
      }
    }

    this.knownSessionKeys = seenSessionKeys;

    // Server-level aggregates: stream count + transcoding count, plus
    // transcoding start/stop events per session.
    let streamCount = 0;
    let transcodingCount = 0;
    for (const snap of nextMap.values()) {
      if (snap.nowPlaying) streamCount++;
      if (snap.isTranscoding) transcodingCount++;
    }

    // Transcoding diffs (per device id).
    for (const [deviceId, nx] of nextMap) {
      const pv = this.lastSnapshots.get(deviceId);
      const wasTrans = pv?.isTranscoding === true;
      const isTrans = nx.isTranscoding === true;
      if (!wasTrans && isTrans && nx.nowPlaying) {
        this.emit('transcoding:started', {
          user: nx.userName ?? '',
          deviceName: nx.deviceName,
          title: nx.nowPlaying.Name,
          reasons: nx.transcodeReasons ?? [],
        });
      } else if (wasTrans && !isTrans && pv?.nowPlaying) {
        this.emit('transcoding:stopped', {
          user: pv.userName ?? '',
          title: pv.nowPlaying.Name,
        });
      }
    }

    if (streamCount !== this.lastStreamCount || transcodingCount !== this.lastTranscodingCount) {
      this.lastStreamCount = streamCount;
      this.lastTranscodingCount = transcodingCount;
      this.emit('streams:count', { count: streamCount, transcoding: transcodingCount });
      this.adjustPolling();
    }
  }

  private toSnapshot(s: JellyfinSession): ClientSnapshot {
    const ps = s.PlayState ?? {};
    const item = s.NowPlayingItem;
    return {
      deviceId: s.DeviceId,
      sessionId: s.Id,
      clientName: s.Client,
      deviceName: s.DeviceName,
      userId: s.UserId,
      userName: s.UserName,
      online: true,
      isPaused: ps.IsPaused === true,
      isMuted: ps.IsMuted === true,
      volumeLevel: typeof ps.VolumeLevel === 'number' ? ps.VolumeLevel : undefined,
      positionSeconds:
        typeof ps.PositionTicks === 'number' ? Math.round(ps.PositionTicks / TICKS_PER_SECOND) : undefined,
      durationSeconds:
        typeof item?.RunTimeTicks === 'number'
          ? Math.round(item.RunTimeTicks / TICKS_PER_SECOND)
          : undefined,
      nowPlaying: item,
      posterUrl:
        item && item.ImageTags?.Primary
          ? this.client.imageUrl(item.Id, 'Primary', item.ImageTags.Primary, 600)
          : undefined,
      lastActivityMs: s.LastActivityDate ? Date.parse(s.LastActivityDate) : undefined,
      isTranscoding: !!s.TranscodingInfo,
      transcodeReasons: s.TranscodingInfo?.TranscodeReasons,
      audioStreamIndex: ps.AudioStreamIndex,
      subtitleStreamIndex: ps.SubtitleStreamIndex,
    };
  }

  // --- Library handling --------------------------------------------------

  private async refreshLibrary(): Promise<void> {
    try {
      const [counts, latest, folders] = await Promise.all([
        this.client.getItemCounts(this.opts.userId).catch(() => undefined),
        this.client.getLatestItems({ userId: this.opts.userId, limit: 50 }).catch(() => []),
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

      // Persist a bounded set so the cache doesn't grow unboundedly.
      const merged = Array.from(new Set([...currentIds, ...this.lastItemIds])).slice(
        0,
        MAX_PERSISTED_IDS,
      );
      this.lastItemIds = new Set(merged);
      this.bootstrapped = true;
      if (this.saveItemIds) {
        try {
          await this.saveItemIds(merged);
        } catch (err) {
          if (this.opts.debug) console.log('[ServerHub] saveItemIds failed', err);
        }
      }
    } catch (err) {
      if (this.opts.debug) console.log('[ServerHub] refreshLibrary failed', err);
    }
  }

  private handleScheduledTask(data: unknown): void {
    const entry = data as
      | { Key?: string; Status?: string; StartTimeUtc?: string; EndTimeUtc?: string }
      | undefined;
    if (!entry) return;
    if (entry.Key && entry.Key.toLowerCase().includes('refreshlibrary')) {
      let duration = 0;
      if (entry.StartTimeUtc && entry.EndTimeUtc) {
        duration = Math.max(
          0,
          Math.round((Date.parse(entry.EndTimeUtc) - Date.parse(entry.StartTimeUtc)) / 1000),
        );
      } else if (this.scanStartedAt) {
        duration = Math.round((Date.now() - this.scanStartedAt) / 1000);
        this.scanStartedAt = undefined;
      }
      this.emit('library:scan_finished', duration);
      // Refresh counts immediately after a scan.
      this.refreshLibrary().catch(() => undefined);
    }
  }

  private handleActivityLog(entries: unknown[]): void {
    for (const raw of entries) {
      const entry = raw as
        | { Type?: string; Name?: string; ShortOverview?: string; Severity?: string }
        | undefined;
      if (!entry || !entry.Type) continue;

      const type = entry.Type;
      // Surface notable activity log events for trigger fan-out.
      if (type === 'SessionStarted' || type === 'SessionEnded' || type === 'AuthenticationFailed') {
        this.emit('activity', { type, name: entry.Name, overview: entry.ShortOverview });
      }
    }
  }

  /** Marks a manual scan as started; helps compute duration on the resulting ScheduledTaskEnded. */
  markScanStarted(): void {
    this.scanStartedAt = Date.now();
  }

  getLastCounts(): ItemCounts | undefined {
    return this.lastCounts;
  }

  /** Returns currently online sessions with NowPlayingItem (used by widget API). */
  async getActiveStreams(): Promise<ClientSnapshot[]> {
    try {
      const sessions = await this.client.getSessions();
      return sessions
        .filter((s) => !!s.NowPlayingItem)
        .map((s) => this.toSnapshot(s));
    } catch {
      return Array.from(this.lastSnapshots.values()).filter((s) => s.nowPlaying);
    }
  }
}
