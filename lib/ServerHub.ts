import { EventEmitter } from 'events';
import { URL } from 'url';
import {
  ItemCounts,
  JellyfinClient,
  JellyfinSession,
  LatestItem,
  MediaSegment,
  NowPlayingItem,
} from './JellyfinClient';
import { JellyfinSocket, TimerProvider, defaultTimers } from './JellyfinSocket';

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
  /** How often to check /System/Info for an available server update (min 1 h). */
  updateCheckMs?: number;
  /** Injectable timer functions (Homey-bound in app code); defaults to the globals. */
  timers?: TimerProvider;
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
  /** CollectionFolder id of the library the item belongs to ('' if unknown). */
  libraryId: string;
  libraryName: string;
  posterUrl?: string;
}

/** Compact projection of a recently-added library item (see getLatestList). */
export interface LatestListEntry {
  id: string;
  name: string;
  type: string;
  seriesName?: string;
  imageTag?: string;
}

/** Compact projection of a continue-watching item (see getResumeList). */
export interface ResumeListEntry extends LatestListEntry {
  progressPercent?: number;
}

/** Compact projection of a remote-controllable session (see getControllableSessions). */
export interface ControllableSession {
  sessionId: string;
  deviceId: string;
  clientName: string;
  userName: string;
}

const TICKS_PER_SECOND = 10_000_000;
const DEFAULT_LIBRARY_POLL_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_POLL_MS = 30 * 1000;
const DEFAULT_ACTIVE_POLL_MS = 5 * 1000;
const MAX_PERSISTED_IDS = 500;
// Overall cap on "latest items" considered per refresh (across all libraries).
const MAX_LATEST_ITEMS = 50;
// Remote-control commands look up the live session right before sending, but a
// volume slider can fire several times in a row — cache the lookup this long so
// we don't hammer /Sessions on every tick.
const LIVE_SESSION_TTL_MS = 1500;
// A device that vanishes from /Sessions for a single poll is usually a transient
// gap (socket blip, ActiveWithin filtering) on a still-live stream, not a stop.
// Ride out missing polls this long before flipping it offline so we don't fire a
// spurious "stopped". A genuine Stop with the client still connected clears
// NowPlayingItem while the device stays present, so it is unaffected by this.
const OFFLINE_GRACE_MS = 11 * 1000;
// Media-segment lookups are keyed by item id; intros/outros are queried per
// played episode, so a small LRU (negatives included) keeps memory flat.
const MEDIA_SEGMENTS_CACHE_MAX = 30;
// activity:auth_failed fan-out cap: at most this many emits per rolling minute.
const AUTH_FAILED_MAX_PER_WINDOW = 5;
const AUTH_FAILED_WINDOW_MS = 60 * 1000;
// server:update_available checks piggyback on the library poll; never more
// often than hourly, default every 6 h.
const DEFAULT_UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const MIN_UPDATE_CHECK_MS = 60 * 60 * 1000;
// runScheduledTask monitoring: poll cadence and give-up horizon.
const TASK_MONITOR_POLL_MS = 10 * 1000;
const TASK_MONITOR_TIMEOUT_MS = 30 * 60 * 1000;
// Compact list caps + TTLs (resource rules: no raw items, everything bounded).
const LATEST_LIST_MAX = 20;
const RESUME_LIST_MAX = 12;
const RESUME_CACHE_TTL_MS = 60 * 1000;
const CONTROLLABLE_SESSIONS_TTL_MS = 10 * 1000;
const CONTROLLABLE_SESSIONS_MAX = 50;

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
  // False until the first Sessions frame has been processed. Suppresses the
  // user:logged_in burst that would otherwise fire for every already-connected
  // session on app start/reload (knownSessionKeys is empty on that first pass).
  private sessionsBootstrapped = false;
  // Dispatch time of the freshest Sessions data applied so far. Sessions can
  // arrive out of order (a slow /Sessions poll resolving after a newer socket
  // frame or a later poll); applying the stale one would rewind now-playing and
  // emit a spurious stopped→started. Older-than-this frames are dropped.
  private lastAppliedSessionsAt = 0;
  private socketOpen = false;
  private lastStreamCount = 0;
  private lastTranscodingCount = 0;
  private liveSessionCache = new Map<string, { at: number; snap?: ClientSnapshot }>();
  private liveClientCache = new Map<string, { at: number; snap?: ClientSnapshot }>();
  // Per (client-app, user) snapshots powering "Follow-App" player devices.
  private lastAppSnapshots = new Map<string, ClientSnapshot>();
  private liveAppCache = new Map<string, { at: number; snap?: ClientSnapshot }>();
  // deviceId -> first timestamp it went missing from /Sessions (for OFFLINE_GRACE_MS).
  private deviceMissedSince = new Map<string, number>();
  // Set by stop(); guards every async continuation (in-flight polls, socket
  // callbacks) so a stopped hub can never restart a timer and live on as a zombie.
  private stopped = false;
  // LRU of per-item media segments (empty arrays cached too, so an old server
  // without the endpoint isn't re-queried on every played episode).
  private mediaSegmentsCache = new Map<string, MediaSegment[]>();
  // Timestamps of recent activity:auth_failed emits (rolling-minute rate limit).
  private authFailedEmits: number[] = [];
  private authFailedOverflowLogged = false;
  // server:update_available state — fires only on the false→true transition.
  private lastUpdateCheckAt = 0;
  private lastUpdateAvailable = false;
  // Pending task-monitor timers (cleared on stop()).
  private taskMonitorTimers = new Set<NodeJS.Timeout>();
  // Compact projection of the newest library items, refreshed by refreshLibrary.
  private latestList: LatestListEntry[] = [];
  private resumeCache?: { at: number; items: ResumeListEntry[] };
  private controllableCache?: { at: number; items: ControllableSession[] };

  private readonly libraryPollMs: number;
  private readonly fallbackPollMs: number;
  private readonly activePollMs: number;
  private readonly updateCheckMs: number;
  private readonly saveItemIds?: (ids: string[]) => void | Promise<void>;
  private readonly timers: TimerProvider;

  constructor(private readonly opts: ServerHubOptions) {
    super();
    this.setMaxListeners(50);

    this.libraryPollMs = opts.libraryPollMs ?? DEFAULT_LIBRARY_POLL_MS;
    this.fallbackPollMs = opts.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;
    this.activePollMs = opts.activePollMs ?? DEFAULT_ACTIVE_POLL_MS;
    this.updateCheckMs = Math.max(opts.updateCheckMs ?? DEFAULT_UPDATE_CHECK_MS, MIN_UPDATE_CHECK_MS);
    this.saveItemIds = opts.saveItemIds;
    this.timers = opts.timers ?? defaultTimers;

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
      insecureTls: opts.insecureTls,
      timers: this.timers,
    });

    this.socket.on('open', () => {
      if (this.stopped) return;
      const wasOpen = this.socketOpen;
      this.socketOpen = true;
      if (!wasOpen) this.emit('connection:up');
      this.adjustPolling();
    });
    this.socket.on('close', () => {
      if (this.stopped) return;
      const wasOpen = this.socketOpen;
      this.socketOpen = false;
      if (wasOpen) this.emit('connection:down');
      this.adjustPolling();
    });
    this.socket.on('sessions', (data) => this.handleSessions(data as JellyfinSession[]));
    this.socket.on('libraryChanged', () => {
      if (this.stopped) return;
      this.refreshLibrary().catch((err) => this.emit('error', err));
    });
    this.socket.on('scheduledTaskEnded', (data) => {
      if (this.stopped) return;
      this.handleScheduledTask(data);
    });
    this.socket.on('activityLogEntry', (entries) => {
      if (this.stopped) return;
      this.handleActivityLog(entries);
    });
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
    this.stopped = false;
    this.socket.start();
    await this.refreshLibrary().catch((err) => {
      if (this.opts.debug) console.log('[ServerHub] initial refresh failed', err);
    });
    if (this.stopped) return;
    this.libraryPollTimer = this.timers.setInterval(() => {
      this.refreshLibrary().catch(() => undefined);
      // Piggyback the (heavily throttled) update check on the existing poll
      // instead of running yet another timer.
      this.maybeCheckUpdate().catch(() => undefined);
    }, this.libraryPollMs);
    this.adjustPolling();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.libraryPollTimer) {
      this.timers.clearInterval(this.libraryPollTimer);
      this.libraryPollTimer = undefined;
    }
    this.stopSessionPoll();
    for (const timer of this.taskMonitorTimers) this.timers.clearTimeout(timer);
    this.taskMonitorTimers.clear();
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

  /** Drops the short-lived live-session caches so the next lookup re-fetches. */
  invalidateSessionCaches(): void {
    this.liveSessionCache.clear();
    this.liveClientCache.clear();
    this.liveAppCache.clear();
  }

  /** Stable key for a (client-app, user) pair, used for Follow-App events/snapshots. */
  static appKey(clientName: string, userId: string): string {
    return `${clientName} ${userId}`;
  }

  /**
   * Latest active snapshot for a client app + user, independent of which
   * Jellyfin DeviceId it currently runs on. Used by Follow-App player devices so
   * a new browser session doesn't orphan the device.
   */
  getAppSnapshot(clientName: string, userId: string): ClientSnapshot | undefined {
    return this.lastAppSnapshots.get(ServerHub.appKey(clientName, userId));
  }

  /**
   * Live session lookup for a Follow-App player: finds the current session of
   * `clientName` for `userId` with a direct /Sessions round-trip so remote
   * control targets whatever browser/device the user is on right now.
   * TTL-cached like the sibling lookups.
   */
  async getLiveClientSessionByApp(
    clientName: string,
    userId: string,
  ): Promise<ClientSnapshot | undefined> {
    const key = ServerHub.appKey(clientName, userId);
    const cached = this.liveAppCache.get(key);
    if (cached && Date.now() - cached.at < LIVE_SESSION_TTL_MS) {
      return cached.snap ?? this.getAppSnapshot(clientName, userId);
    }
    const sessions = await this.client.getSessions();
    const snaps = sessions
      .filter(
        (s) =>
          s.Client === clientName &&
          s.UserId === userId &&
          s.DeviceId &&
          s.DeviceId !== this.opts.homeyDeviceId,
      )
      .map((s) => this.toSnapshot(s));
    const active = ServerHub.pickActiveSnapshot(snaps);
    // Only the TTL cache is updated here — lastAppSnapshots is the prev-baseline
    // of diffSessions, and writing the live result into it swallows the very
    // started/paused/stopped transition the next handleSessions should emit.
    this.liveAppCache.set(key, { at: Date.now(), snap: active });
    return active ?? this.getAppSnapshot(clientName, userId);
  }

  /**
   * Live session lookup used right before sending a remote-control command
   * (play/pause, volume, mute, …). Hits /Sessions directly so the first command
   * after playback starts or the app restarts targets the *current* session,
   * not a stale/idle one from the last socket frame. Bounded by a short TTL so
   * rapid volume changes don't hammer the server; falls back to the cached
   * per-user snapshot on error.
   */
  async getLiveUserSession(userId: string): Promise<ClientSnapshot | undefined> {
    const cached = this.liveSessionCache.get(userId);
    if (cached && Date.now() - cached.at < LIVE_SESSION_TTL_MS) {
      return cached.snap ?? this.getUserSnapshot(userId);
    }
    const sessions = await this.client.getSessions();
    const snaps = sessions
      .filter((s) => s.UserId === userId && s.DeviceId && s.DeviceId !== this.opts.homeyDeviceId)
      .map((s) => this.toSnapshot(s));
    const active = ServerHub.pickActiveSnapshot(snaps);
    // TTL cache only — never lastUserSnapshots (the diff baseline), see
    // getLiveClientSessionByApp.
    this.liveSessionCache.set(userId, { at: Date.now(), snap: active });
    return active ?? this.getUserSnapshot(userId);
  }

  /**
   * Live session lookup for a specific client (Jellyfin DeviceId), optionally
   * pinned to a user. Used by the Player driver so a remote-control command
   * targets that client's current session instead of a stale cached one.
   * TTL-cached like getLiveUserSession; the fallback only returns the cached
   * snapshot when it still belongs to the requested user.
   */
  async getLiveClientSession(deviceId: string, userId?: string): Promise<ClientSnapshot | undefined> {
    const cachedByUser = (): ClientSnapshot | undefined => {
      const c = this.getClientSnapshot(deviceId);
      return c && (!userId || c.userId === userId) ? c : undefined;
    };
    const key = `${deviceId}:${userId ?? ''}`;
    const cached = this.liveClientCache.get(key);
    if (cached && Date.now() - cached.at < LIVE_SESSION_TTL_MS) {
      return cached.snap ?? cachedByUser();
    }
    const sessions = await this.client.getSessions();
    const match = sessions.find(
      (s) => s.DeviceId === deviceId && (!userId || s.UserId === userId),
    );
    const snap = match ? this.toSnapshot(match) : undefined;
    // TTL cache only — never lastSnapshots (the diff baseline), see
    // getLiveClientSessionByApp.
    this.liveClientCache.set(key, { at: Date.now(), snap });
    return snap ?? cachedByUser();
  }

  /**
   * Picks the most active snapshot for a user from a list of candidates.
   * `preferSessionId`, when given and still carrying a NowPlayingItem, wins —
   * this keeps a Follow-App device pinned to the session it was already
   * tracking so two concurrent sessions of the same client app don't make the
   * pick (and thus the now-playing item / Flow triggers) flap every poll.
   */
  static pickActiveSnapshot(
    snaps: ClientSnapshot[],
    preferSessionId?: string,
  ): ClientSnapshot | undefined {
    if (snaps.length === 0) return undefined;
    if (preferSessionId) {
      const pinned = snaps.find((s) => s.sessionId === preferSessionId && s.nowPlaying);
      // Keep following the pinned session, but yield if it is paused while a
      // different session of the same app is actively playing — otherwise a
      // paused tab would wedge the device and never advance to the live one.
      if (pinned) {
        const otherPlaying = snaps.some(
          (s) => s.sessionId !== preferSessionId && s.nowPlaying && !s.isPaused,
        );
        if (!pinned.isPaused || !otherPlaying) return pinned;
      }
    }
    return [...snaps].sort((a, b) => {
      const aHas = a.nowPlaying ? 1 : 0;
      const bHas = b.nowPlaying ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const aOnline = a.online ? 1 : 0;
      const bOnline = b.online ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      // An actively-playing session is more "active" than a paused one.
      const aPlaying = a.nowPlaying && !a.isPaused ? 1 : 0;
      const bPlaying = b.nowPlaying && !b.isPaused ? 1 : 0;
      if (aPlaying !== bPlaying) return bPlaying - aPlaying;
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
    if (this.stopped) return;
    const hasActive = this.lastStreamCount > 0;
    let desiredMs: number | undefined;
    if (!this.socketOpen) desiredMs = this.fallbackPollMs;
    else if (hasActive) desiredMs = this.activePollMs;
    else desiredMs = undefined;

    if (desiredMs === this.currentPollMs) return;
    this.stopSessionPoll();
    if (desiredMs) {
      this.currentPollMs = desiredMs;
      this.sessionPollTimer = this.timers.setInterval(
        () => this.pollSessions().catch(() => undefined),
        desiredMs,
      );
    }
  }

  private stopSessionPoll(): void {
    if (this.sessionPollTimer) {
      this.timers.clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = undefined;
    }
    this.currentPollMs = undefined;
  }

  // --- Sessions handling -------------------------------------------------

  private async pollSessions(): Promise<void> {
    if (this.stopped) return;
    // Stamp the dispatch time up front so a slow response overtaken by a socket
    // frame (or a newer poll) is dropped by handleSessions rather than
    // rewinding state to this older snapshot.
    const dispatchedAt = Date.now();
    try {
      const sessions = await this.client.getSessions();
      this.handleSessions(sessions, dispatchedAt);
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
      if (prevItem && !nextItem) {
        // A session that was playing and now has no item is a stop — whether it
        // stayed online with NowPlayingItem cleared (pressed Stop) OR went
        // offline entirely (browser tab closed / app killed). The latter is the
        // *normal* way browser playback ends, so gating on nx.online here made
        // the stopped trigger silently miss it. A device that was NOT playing
        // has prevItem undefined, so this never invents a spurious stop.
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

  private handleSessions(sessions: JellyfinSession[], dispatchedAt: number = Date.now()): void {
    // A stopped hub must not process late frames — they would re-arm the
    // session poll via adjustPolling and leak a zombie interval.
    if (this.stopped) return;
    // Drop out-of-order data: only apply a frame at least as fresh as the last
    // one applied. Socket frames default dispatchedAt to now and arrive in
    // order, so they never drop each other; only a poll response that lost the
    // race to a newer frame is skipped (see lastAppliedSessionsAt).
    if (dispatchedAt < this.lastAppliedSessionsAt) return;
    this.lastAppliedSessionsAt = dispatchedAt;
    const now = Date.now();
    const seenDeviceIds = new Set<string>();
    const seenSessionKeys = new Set<string>();
    const nextMap = new Map<string, ClientSnapshot>();

    for (const s of sessions) {
      if (!s.DeviceId) continue;
      // The app itself shows up in /Sessions (client "Homeyfin"); never treat
      // it as a controllable player or let it win the per-user "active" pick.
      if (s.DeviceId === this.opts.homeyDeviceId) continue;
      seenDeviceIds.add(s.DeviceId);

      const sessionKey = `${s.DeviceId}:${s.UserId ?? 'anon'}`;
      seenSessionKeys.add(sessionKey);
      // Skip the first pass so already-connected sessions don't all fire
      // logged_in on startup/reload; genuine new logins on later passes fire.
      if (this.sessionsBootstrapped && !this.knownSessionKeys.has(sessionKey) && s.UserName) {
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

    // Devices that disappeared surface exactly one offline snapshot, then get
    // evicted. Jellyfin mints a fresh DeviceId per browser/profile, so without
    // eviction lastSnapshots (and the per-poll `client:<id>:update` fan-out)
    // would grow without bound across every browser session ever seen.
    for (const [deviceId, prev] of this.lastSnapshots) {
      if (seenDeviceIds.has(deviceId)) {
        this.deviceMissedSince.delete(deviceId);
        continue;
      }
      if (!prev.online) {
        // Its offline update was already delivered on an earlier poll — drop it.
        this.lastSnapshots.delete(deviceId);
        this.deviceMissedSince.delete(deviceId);
        continue;
      }
      // Online but missing this poll: hold it as-is through a short grace so a
      // single dropped /Sessions frame doesn't emit a spurious stopped+started.
      const missedSince = this.deviceMissedSince.get(deviceId) ?? now;
      this.deviceMissedSince.set(deviceId, missedSince);
      if (now - missedSince < OFFLINE_GRACE_MS) {
        nextMap.set(deviceId, prev);
        // The session is still considered present — keep its key known so a
        // one-frame blip doesn't re-fire user:logged_in when it reappears.
        seenSessionKeys.add(`${deviceId}:${prev.userId ?? 'anon'}`);
        continue;
      }
      this.deviceMissedSince.delete(deviceId);
      nextMap.set(deviceId, {
        ...prev,
        online: false,
        isPaused: false,
        nowPlaying: undefined,
      });
    }

    const events = ServerHub.diffSessions(this.lastSnapshots, nextMap);

    // Snapshot the pre-update state before the map is overwritten below. Both
    // the stopped-event item fallback and the transcoding diff further down
    // need the *previous* snapshot; reading this.lastSnapshots after the
    // overwrite loop yields the new one (== nx), which silently blanked the
    // stopped item and made the transcoding diff a no-op. Mirrors the
    // prevAppItems capture in the app-key path below.
    const prevSnapshots = new Map(this.lastSnapshots);

    for (const [deviceId, snap] of nextMap) {
      this.lastSnapshots.set(deviceId, snap);
      this.emit(`client:${deviceId}:update`, snap);
    }

    for (const ev of events) {
      const snap = nextMap.get(ev.deviceId);
      if (!snap) continue;
      const item = snap.nowPlaying ?? prevSnapshots.get(ev.deviceId)?.nowPlaying;
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
    // emits a stopped event exactly once — then evict on the next frame, like
    // lastSnapshots above, so the map (and the per-frame update fan-out) doesn't
    // grow forever with users that are long gone.
    for (const [userId, prev] of this.lastUserSnapshots) {
      if (nextUserMap.has(userId)) continue;
      if (!prev.online) {
        this.lastUserSnapshots.delete(userId);
        continue;
      }
      const offline: ClientSnapshot = {
        ...prev,
        online: false,
        isPaused: false,
        nowPlaying: undefined,
      };
      nextUserMap.set(userId, offline);
    }

    const userEvents = ServerHub.diffSessions(this.lastUserSnapshots, nextUserMap);
    // Capture the pre-update now-playing items before the map is overwritten,
    // so a stopped event still carries the title that was playing (the same
    // reason the app-key path snapshots prevAppItems). Without this the user
    // device receives an undefined item and, per its `if (item)` guard in
    // firePendingStop(), the playback_stopped trigger never fires at all.
    const prevUserItems = new Map<string, NowPlayingItem | undefined>();
    for (const [userId, snap] of this.lastUserSnapshots) prevUserItems.set(userId, snap.nowPlaying);
    for (const [userId, snap] of nextUserMap) {
      this.lastUserSnapshots.set(userId, snap);
      this.emit(`user:${userId}:update`, snap);
    }
    for (const ev of userEvents) {
      const snap = nextUserMap.get(ev.deviceId); // deviceId field reused for the key
      if (!snap) continue;
      const item = snap.nowPlaying ?? prevUserItems.get(ev.deviceId);
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

    // Per (client-app, user) grouping — powers Follow-App players that track
    // whichever session of a client app the user is on, not a fixed DeviceId.
    const byApp = new Map<string, ClientSnapshot[]>();
    for (const snap of nextMap.values()) {
      if (!snap.userId || !snap.clientName) continue;
      const key = ServerHub.appKey(snap.clientName, snap.userId);
      const list = byApp.get(key) ?? [];
      list.push(snap);
      byApp.set(key, list);
    }
    const nextAppMap = new Map<string, ClientSnapshot>();
    for (const [key, list] of byApp) {
      // Stay pinned to the session we were already following (if it still has an
      // item) so a second concurrent session of the same app can't hijack it.
      const prevSessionId = this.lastAppSnapshots.get(key)?.sessionId;
      const active = ServerHub.pickActiveSnapshot(list, prevSessionId);
      if (active) nextAppMap.set(key, active);
    }
    // App groups that vanished: keep the last snapshot but mark offline so the
    // diff emits a single stopped event — then evict on the next frame (see the
    // lastUserSnapshots loop above).
    for (const [key, prev] of this.lastAppSnapshots) {
      if (nextAppMap.has(key)) continue;
      if (!prev.online) {
        this.lastAppSnapshots.delete(key);
        continue;
      }
      nextAppMap.set(key, { ...prev, online: false, isPaused: false, nowPlaying: undefined });
    }

    const appEvents = ServerHub.diffSessions(this.lastAppSnapshots, nextAppMap);
    // Capture the pre-update item per key so a "stopped" event still carries the
    // title that was playing (the new snapshot has already cleared nowPlaying).
    const prevAppItems = new Map<string, NowPlayingItem | undefined>();
    for (const [key, snap] of this.lastAppSnapshots) prevAppItems.set(key, snap.nowPlaying);
    for (const [key, snap] of nextAppMap) {
      this.lastAppSnapshots.set(key, snap);
      this.emit(`clientapp:${key}:update`, snap);
    }
    for (const ev of appEvents) {
      const key = ev.deviceId; // diffSessions reuses the deviceId field for the map key
      const snap = nextAppMap.get(key);
      if (!snap) continue;
      const item = snap.nowPlaying ?? prevAppItems.get(key);
      switch (ev.type) {
        case 'started':
          if (item) this.emit(`clientapp:${key}:playback_started`, snap, item);
          break;
        case 'paused':
          if (item) this.emit(`clientapp:${key}:playback_paused`, snap, item);
          break;
        case 'resumed':
          if (item) this.emit(`clientapp:${key}:playback_resumed`, snap, item);
          break;
        case 'stopped':
          this.emit(`clientapp:${key}:playback_stopped`, snap, item);
          break;
        case 'changed':
          if (item) this.emit(`clientapp:${key}:now_playing_changed`, snap, item);
          break;
      }
    }

    this.knownSessionKeys = seenSessionKeys;
    this.sessionsBootstrapped = true;

    // Server-level aggregates: stream count + transcoding count, plus
    // transcoding start/stop events per session.
    let streamCount = 0;
    let transcodingCount = 0;
    for (const snap of nextMap.values()) {
      if (snap.nowPlaying) streamCount++;
      if (snap.isTranscoding) transcodingCount++;
    }

    // Transcoding diffs (per device id). Use prevSnapshots: this.lastSnapshots
    // was overwritten with nextMap above, so reading it here would compare a
    // snapshot against itself and never detect a start/stop transition.
    for (const [deviceId, nx] of nextMap) {
      const pv = prevSnapshots.get(deviceId);
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
    if (this.stopped) return;
    try {
      const counts = await this.client.getItemCounts(this.opts.userId).catch(() => undefined);
      if (this.stopped) return;
      if (counts) {
        this.lastCounts = counts;
        this.emit('library:counts', counts);
      }

      // Without the folder list we can neither attribute items to a library nor
      // trust an "empty" result — skip this cycle instead of poisoning the
      // new-item baseline.
      const folders = await this.client.getMediaFolders();
      if (this.stopped) return;

      // Query each CollectionFolder separately: a global getLatestItems returns
      // episodes with their *Season* as ParentId, which can't be mapped back to
      // a library folder — per-folder queries give every item its correct
      // libraryId/libraryName.
      let anyFailed = false;
      const perFolder = await Promise.all(
        folders.Items.map(async (folder) => {
          try {
            const items = await this.client.getLatestItems({
              userId: this.opts.userId,
              limit: MAX_LATEST_ITEMS,
              parentId: folder.Id,
            });
            return { folder, items };
          } catch {
            anyFailed = true;
            return { folder, items: [] as LatestItem[] };
          }
        }),
      );
      if (this.stopped) return;

      // A failed fetch must not be mistaken for an empty library: bootstrapping
      // (or persisting) an empty baseline on failure would replay up to
      // MAX_LATEST_ITEMS stale new_item events on the next successful poll.
      if (!this.bootstrapped && anyFailed) return;

      const dedup = new Set<string>();
      const latest: Array<{ item: LatestItem; libraryId: string; libraryName: string }> = [];
      for (const { folder, items } of perFolder) {
        for (const item of items) {
          if (dedup.has(item.Id)) continue;
          dedup.add(item.Id);
          latest.push({ item, libraryId: folder.Id, libraryName: folder.Name });
        }
      }
      // Keep the overall cap the single global query had: newest first.
      const createdAt = (i: LatestItem): number => {
        const t = i.DateCreated ? Date.parse(i.DateCreated) : NaN;
        return Number.isNaN(t) ? 0 : t;
      };
      latest.sort((a, b) => createdAt(b.item) - createdAt(a.item));
      const capped = latest.slice(0, MAX_LATEST_ITEMS);

      // Keep a compact, capped projection for the synchronous getLatestList()
      // consumer — ids + display fields only, never the raw items.
      this.latestList = capped.slice(0, LATEST_LIST_MAX).map(({ item }) => ({
        id: item.Id,
        name: item.Name,
        type: item.Type,
        seriesName: item.SeriesName,
        imageTag: item.ImageTags?.Primary,
      }));

      if (this.bootstrapped) {
        for (const { item, libraryId, libraryName } of capped) {
          if (!this.lastItemIds.has(item.Id)) {
            this.emit('library:new_item', {
              item,
              libraryId,
              libraryName,
              posterUrl: item.ImageTags?.Primary
                ? this.client.imageUrl(item.Id, 'Primary', item.ImageTags.Primary)
                : undefined,
            } as NewItemEvent);
          }
        }
      }

      // Persist a bounded set so the cache doesn't grow unboundedly. A folder
      // that failed above contributes nothing new; its previously known ids
      // survive via the merge, so nothing is re-announced later.
      const currentIds = capped.map((e) => e.item.Id);
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
        | { Type?: string; Name?: string; ShortOverview?: string; Severity?: string; UserName?: string }
        | undefined;
      if (!entry || !entry.Type) continue;

      const type = entry.Type;
      // Surface notable activity log events for trigger fan-out.
      if (type === 'SessionStarted' || type === 'SessionEnded' || type === 'AuthenticationFailed') {
        this.emit('activity', { type, name: entry.Name, overview: entry.ShortOverview });
      }
      if (type.includes('AuthenticationFailed')) {
        this.emitAuthFailed(entry);
      }
    }
  }

  /**
   * Emits 'activity:auth_failed' { userName }, rate-limited to at most
   * AUTH_FAILED_MAX_PER_WINDOW emits per rolling minute — a brute-force run
   * against the server must not turn into an unbounded Flow-trigger burst.
   * Overflow is dropped and logged once per burst.
   */
  private emitAuthFailed(entry: { Name?: string; UserName?: string }): void {
    const now = Date.now();
    this.authFailedEmits = this.authFailedEmits.filter((t) => now - t < AUTH_FAILED_WINDOW_MS);
    if (this.authFailedEmits.length >= AUTH_FAILED_MAX_PER_WINDOW) {
      if (!this.authFailedOverflowLogged) {
        this.authFailedOverflowLogged = true;
        console.log('[ServerHub] auth_failed rate limit reached — dropping further events this minute');
      }
      return;
    }
    this.authFailedOverflowLogged = false;
    this.authFailedEmits.push(now);
    this.emit('activity:auth_failed', { userName: ServerHub.extractAuthFailedUser(entry) });
  }

  /**
   * Best-effort user extraction from an AuthenticationFailed activity entry.
   * The entry name reads e.g. "Failed login attempt made by eve." — fall back
   * to the whole name when the pattern doesn't match.
   */
  static extractAuthFailedUser(entry: { Name?: string; UserName?: string }): string {
    if (entry.UserName) return entry.UserName;
    const name = entry.Name ?? '';
    const match = /(?:made by|for user|by)\s+(.+?)\.?$/i.exec(name);
    return match ? match[1] : name;
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
    // Stable order (by sessionId) so consecutive calls render identically.
    const bySessionId = (a: ClientSnapshot, b: ClientSnapshot): number =>
      a.sessionId.localeCompare(b.sessionId);
    try {
      const sessions = await this.client.getSessions();
      return sessions
        .filter((s) => !!s.NowPlayingItem)
        .map((s) => this.toSnapshot(s))
        .sort(bySessionId);
    } catch {
      return Array.from(this.lastSnapshots.values())
        .filter((s) => s.nowPlaying)
        .sort(bySessionId);
    }
  }

  /**
   * Media segments of an item (intro/outro markers), through a small LRU that
   * caches negatives too — an old server without the endpoint answers 404 for
   * every item and must not be re-queried on each played episode.
   */
  async getMediaSegments(itemId: string): Promise<MediaSegment[]> {
    const hit = this.mediaSegmentsCache.get(itemId);
    if (hit) {
      this.mediaSegmentsCache.delete(itemId);
      this.mediaSegmentsCache.set(itemId, hit);
      return hit;
    }
    const segments = await this.client.getMediaSegments(itemId);
    this.mediaSegmentsCache.set(itemId, segments);
    while (this.mediaSegmentsCache.size > MEDIA_SEGMENTS_CACHE_MAX) {
      const firstKey = this.mediaSegmentsCache.keys().next().value;
      if (firstKey === undefined) break;
      this.mediaSegmentsCache.delete(firstKey);
    }
    return segments;
  }

  /**
   * Throttled server-update check, piggybacked on the library poll (no timer of
   * its own). Runs only while the socket connection is up, at most once per
   * updateCheckMs (>= 1 h), and emits 'server:update_available' {} exactly on
   * the false→true transition.
   */
  private async maybeCheckUpdate(): Promise<void> {
    if (this.stopped || !this.socketOpen) return;
    const now = Date.now();
    if (now - this.lastUpdateCheckAt < this.updateCheckMs) return;
    this.lastUpdateCheckAt = now;
    try {
      const available = await this.client.getUpdateAvailable();
      if (this.stopped) return;
      if (available && !this.lastUpdateAvailable) {
        this.emit('server:update_available', {});
      }
      this.lastUpdateAvailable = available;
    } catch {
      // Transient failure — try again next interval.
    }
  }

  /**
   * Starts a scheduled task and monitors it (poll every 10 s over the injected
   * timers, 30 min give-up horizon, aborted by stop()). When the task returns
   * to Idle, emits 'task:completed' { taskId, taskName, status }.
   */
  async runScheduledTask(taskId: string): Promise<void> {
    await this.client.startScheduledTask(taskId);
    if (this.stopped) return;
    this.scheduleTaskPoll(taskId, Date.now());
  }

  private scheduleTaskPoll(taskId: string, startedAt: number): void {
    const timer = this.timers.setTimeout(() => {
      this.taskMonitorTimers.delete(timer);
      this.pollTask(taskId, startedAt).catch(() => undefined);
    }, TASK_MONITOR_POLL_MS);
    this.taskMonitorTimers.add(timer);
  }

  private async pollTask(taskId: string, startedAt: number): Promise<void> {
    if (this.stopped) return;
    if (Date.now() - startedAt > TASK_MONITOR_TIMEOUT_MS) {
      if (this.opts.debug) console.log('[ServerHub] task monitor timed out', taskId);
      return;
    }
    try {
      const task = await this.client.getScheduledTask(taskId);
      if (this.stopped) return;
      if (!task) return; // task vanished — nothing to report
      if (task.state === 'Idle') {
        this.emit('task:completed', {
          taskId,
          taskName: task.name,
          status: task.lastResultStatus ?? 'Completed',
        });
        return;
      }
    } catch {
      // Transient error — keep polling until the timeout.
    }
    this.scheduleTaskPoll(taskId, startedAt);
  }

  /**
   * Newest library items as a compact projection — synchronous, served from the
   * capped list refreshLibrary maintains anyway (no extra request).
   */
  getLatestList(): LatestListEntry[] {
    return this.latestList;
  }

  /** Continue-watching list (compact projection, cap 12, 60 s TTL cache). */
  async getResumeList(limit?: number): Promise<ResumeListEntry[]> {
    const capped = Math.max(1, Math.min(limit ?? RESUME_LIST_MAX, RESUME_LIST_MAX));
    const now = Date.now();
    if (this.resumeCache && now - this.resumeCache.at < RESUME_CACHE_TTL_MS) {
      return this.resumeCache.items.slice(0, capped);
    }
    const res = await this.client.getResumeItems({
      userId: this.opts.userId,
      limit: RESUME_LIST_MAX,
    });
    const items: ResumeListEntry[] = (res?.Items ?? []).slice(0, RESUME_LIST_MAX).map((i) => ({
      id: i.Id,
      name: i.Name,
      type: i.Type,
      seriesName: i.SeriesName,
      imageTag: i.ImageTags?.Primary,
      progressPercent:
        typeof i.UserData?.PlayedPercentage === 'number'
          ? Math.round(i.UserData.PlayedPercentage)
          : undefined,
    }));
    this.resumeCache = { at: now, items };
    return items.slice(0, capped);
  }

  /** Remote-controllable sessions (compact projection, 10 s TTL cache). */
  async getControllableSessions(): Promise<ControllableSession[]> {
    const now = Date.now();
    if (this.controllableCache && now - this.controllableCache.at < CONTROLLABLE_SESSIONS_TTL_MS) {
      return this.controllableCache.items;
    }
    const sessions = await this.client.getSessions();
    const items: ControllableSession[] = sessions
      .filter(
        (s) =>
          s.SupportsRemoteControl === true &&
          !!s.DeviceId &&
          s.DeviceId !== this.opts.homeyDeviceId,
      )
      .slice(0, CONTROLLABLE_SESSIONS_MAX)
      .map((s) => ({
        sessionId: s.Id,
        deviceId: s.DeviceId,
        clientName: s.Client,
        userName: s.UserName ?? '',
      }));
    this.controllableCache = { at: now, items };
    return items;
  }

  /**
   * Fetches an item's Primary image server-side (with auth, through the
   * client's LRU image cache) and returns it as a data:image/...;base64 URI so
   * widgets can embed it without exposing an api_key URL. Returns null on
   * error or when the item has no image.
   */
  async getPosterDataUri(itemId: string, tag?: string, maxWidth?: number): Promise<string | null> {
    try {
      const url = new URL(`${this.client.getBaseUrl()}/Items/${itemId}/Images/Primary`);
      url.searchParams.set('maxWidth', String(maxWidth ?? 500));
      if (tag) url.searchParams.set('tag', tag);
      url.searchParams.set('api_key', this.client.getApiKey());
      const img = await this.client.getCachedImage(url.toString());
      if (!img) return null;
      return `data:${img.contentType};base64,${img.buffer.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
