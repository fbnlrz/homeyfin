import { URL } from 'url';
import https from 'https';
import http from 'http';

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  deviceName?: string;
  clientName?: string;
  appVersion?: string;
  /** When true, accept self-signed TLS certificates (Homey LAN setups). */
  insecureTls?: boolean;
}

export interface SystemInfo {
  Id: string;
  ServerName: string;
  Version: string;
  LocalAddress?: string;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  IsAdministrator?: boolean;
  HasPassword?: boolean;
  LastLoginDate?: string;
}

export interface JellyfinSession {
  Id: string;
  UserId?: string;
  UserName?: string;
  DeviceId: string;
  DeviceName: string;
  Client: string;
  ApplicationVersion?: string;
  LastActivityDate?: string;
  PlayState?: {
    PositionTicks?: number;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    PlayMethod?: string;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
  };
  NowPlayingItem?: NowPlayingItem;
  TranscodingInfo?: {
    AudioCodec?: string;
    VideoCodec?: string;
    Container?: string;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    Bitrate?: number;
    CompletionPercentage?: number;
    Width?: number;
    Height?: number;
    AudioChannels?: number;
    Framerate?: number;
    HardwareAccelerationType?: string;
    TranscodeReasons?: string[];
  };
  SupportsRemoteControl?: boolean;
}

export interface NowPlayingItem {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  SeasonName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  ImageTags?: Record<string, string>;
  ParentBackdropImageTags?: string[];
  MediaStreams?: Array<{
    Index: number;
    Type: 'Audio' | 'Subtitle' | 'Video';
    DisplayTitle?: string;
    Language?: string;
    Codec?: string;
    IsDefault?: boolean;
  }>;
  Chapters?: Array<{ StartPositionTicks: number; Name?: string }>;
}

export interface SystemInfoFull extends SystemInfo {
  OperatingSystem?: string;
  StartupWizardCompleted?: boolean;
  WebSocketPortNumber?: number;
  CompletedInstallations?: unknown[];
  HasPendingRestart?: boolean;
  IsShuttingDown?: boolean;
  ProgramDataPath?: string;
  ItemsByNamePath?: string;
  CachePath?: string;
  LogPath?: string;
  InternalMetadataPath?: string;
  TranscodingTempPath?: string;
}

export interface ItemCounts {
  MovieCount: number;
  SeriesCount: number;
  EpisodeCount: number;
  SongCount?: number;
  AlbumCount?: number;
  BookCount?: number;
}

export interface MediaFolder {
  Id: string;
  Name: string;
  CollectionType?: string;
}

/** Compact media-segment projection (intro/outro/recap markers), ticks already converted. */
export interface MediaSegment {
  type: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ScheduledTaskSummary {
  id: string;
  name: string;
  category?: string;
  state: string;
}

export interface LatestItem {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  DateCreated?: string;
  ImageTags?: Record<string, string>;
  ParentId?: string;
  UserData?: {
    Played?: boolean;
    IsFavorite?: boolean;
    UnplayedItemCount?: number;
    PlaybackPositionTicks?: number;
    PlayCount?: number;
    PlayedPercentage?: number;
  };
}

export type PlaystateCommand =
  | 'Pause'
  | 'Unpause'
  | 'PlayPause'
  | 'Stop'
  | 'NextTrack'
  | 'PreviousTrack'
  | 'Seek';

export type GeneralCommand =
  | 'VolumeUp'
  | 'VolumeDown'
  | 'SetVolume'
  | 'Mute'
  | 'Unmute'
  | 'ToggleMute'
  | 'SetAudioStreamIndex'
  | 'SetSubtitleStreamIndex'
  | 'DisplayMessage'
  | 'GoHome'
  | 'Back'
  | 'Select'
  | 'MoveUp'
  | 'MoveDown'
  | 'MoveLeft'
  | 'MoveRight';

const TICKS_PER_SECOND = 10_000_000;

export class JellyfinError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'JellyfinError';
  }
}

interface CachedImage {
  buffer: Buffer;
  contentType: string;
  fetchedAt: number;
}

interface RawResponse {
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
}

export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;
  private deviceId: string;
  private deviceName: string;
  private clientName: string;
  private appVersion: string;
  private insecureAgent?: https.Agent;
  private imageCache = new Map<string, CachedImage>();
  private static readonly IMAGE_CACHE_MAX = 64;
  private static readonly IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
  private static readonly REQUEST_TIMEOUT_MS = 12_000;

  constructor(opts: JellyfinClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.deviceId = opts.deviceId;
    this.deviceName = opts.deviceName ?? 'Homey';
    this.clientName = opts.clientName ?? 'Homeyfin';
    this.appVersion = opts.appVersion ?? '0.1.0';
    if (opts.insecureTls) {
      this.insecureAgent = new https.Agent({ rejectUnauthorized: false });
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  private authHeader(): string {
    const base =
      `MediaBrowser Client="${this.clientName}", ` +
      `Device="${this.deviceName}", ` +
      `DeviceId="${this.deviceId}", ` +
      `Version="${this.appVersion}"`;
    // No apiKey (QuickConnect bootstrap): send the header without a Token part —
    // Jellyfin rejects an empty Token, but accepts the anonymous client header.
    if (!this.apiKey) return base;
    return `${base}, Token="${this.apiKey}"`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const raw = await this.fetchRaw(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (raw.status < 200 || raw.status >= 300) {
      const text = raw.body.toString('utf8');
      throw new JellyfinError(
        `Jellyfin ${method} ${path} failed: ${raw.status} ${raw.statusText}${text ? ` – ${text}` : ''}`,
        raw.status,
      );
    }

    if (raw.status === 204 || raw.body.length === 0) return undefined as unknown as T;
    if (raw.contentType.includes('application/json')) {
      return JSON.parse(raw.body.toString('utf8')) as T;
    }
    return raw.body.toString('utf8') as unknown as T;
  }

  /**
   * Single low-level fetch used by every request. Applies a hard timeout via
   * AbortController (undici's default header timeout is ~5 min, long enough to
   * wedge polling behind a black-holed connection), and — crucially — routes
   * self-signed HTTPS through Node's `https` with the insecure agent, because
   * the global `fetch` (undici) silently ignores the `agent` option and only
   * honours a `dispatcher`, which the bundled runtime doesn't expose.
   */
  private async fetchRaw(
    url: URL,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs: number = JellyfinClient.REQUEST_TIMEOUT_MS,
  ): Promise<RawResponse> {
    if (this.insecureAgent && url.protocol === 'https:') {
      return this.nodeRequest(url, init, timeoutMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      const arrayBuf = await res.arrayBuffer();
      return {
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get('content-type') ?? '',
        body: Buffer.from(arrayBuf),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Node http(s) fallback so a self-signed cert (insecureTls) actually works. */
  private nodeRequest(
    url: URL,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    timeoutMs: number,
    redirectsLeft = 5,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      const bodyBuf = init.body !== undefined ? Buffer.from(init.body, 'utf8') : undefined;
      // Set Content-Length explicitly (Node would otherwise chunk the body).
      if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length);

      const req = lib.request(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          agent: url.protocol === 'https:' ? this.insecureAgent : undefined,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          // undici (the global fetch) follows redirects; match that on this path.
          if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
            res.resume(); // drain so the socket can be reused
            let next: URL;
            try {
              next = new URL(location, url);
            } catch (err) {
              reject(err);
              return;
            }
            this.nodeRequest(next, init, timeoutMs, redirectsLeft - 1).then(resolve, reject);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject); // a mid-body reset must reject, not hang/throw
          res.on('end', () =>
            resolve({
              status,
              statusText: res.statusMessage ?? '',
              contentType: (res.headers['content-type'] as string) ?? '',
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  // --- Discovery / auth ---

  getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('GET', '/System/Info');
  }

  getUsers(): Promise<JellyfinUser[]> {
    return this.request<JellyfinUser[]>('GET', '/Users');
  }

  // --- QuickConnect (works without an apiKey, see authHeader) ---

  /** Whether the server has QuickConnect enabled. */
  async quickConnectEnabled(): Promise<boolean> {
    const res = await this.request<boolean | string>('GET', '/QuickConnect/Enabled');
    return res === true || res === 'true';
  }

  /** Starts a QuickConnect flow; the code is shown to the user, the secret polled. */
  async quickConnectInitiate(): Promise<{ secret: string; code: string }> {
    const res = await this.request<{ Secret?: string; Code?: string }>(
      'POST',
      '/QuickConnect/Initiate',
    );
    if (!res?.Secret || !res?.Code) {
      throw new JellyfinError('QuickConnect initiate returned no secret/code');
    }
    return { secret: res.Secret, code: res.Code };
  }

  /** Polls a QuickConnect flow; true once the user has approved the code. */
  async quickConnectState(secret: string): Promise<boolean> {
    const res = await this.request<{ Authenticated?: boolean }>(
      'GET',
      '/QuickConnect/Connect',
      undefined,
      { Secret: secret },
    );
    return res?.Authenticated === true;
  }

  /** Exchanges an approved QuickConnect secret for an access token. */
  async authenticateWithQuickConnect(
    secret: string,
  ): Promise<{ accessToken: string; userId: string; userName: string }> {
    const res = await this.request<{
      AccessToken?: string;
      User?: { Id?: string; Name?: string };
    }>('POST', '/Users/AuthenticateWithQuickConnect', { Secret: secret });
    if (!res?.AccessToken || !res.User?.Id) {
      throw new JellyfinError('QuickConnect authentication returned no token');
    }
    return {
      accessToken: res.AccessToken,
      userId: res.User.Id,
      userName: res.User.Name ?? '',
    };
  }

  // --- User policy (admin token required) ---

  /** Whether a user account is disabled. */
  async getUserDisabled(userId: string): Promise<boolean> {
    const user = await this.request<{ Policy?: { IsDisabled?: boolean } }>(
      'GET',
      `/Users/${userId}`,
    );
    return user?.Policy?.IsDisabled === true;
  }

  /**
   * Enables/disables a user account. Jellyfin's policy endpoint replaces the
   * WHOLE policy object — posting only IsDisabled would wipe every other
   * permission, so read-modify-write the full policy.
   */
  async setUserDisabled(userId: string, disabled: boolean): Promise<void> {
    const user = await this.request<{ Policy?: Record<string, unknown> }>(
      'GET',
      `/Users/${userId}`,
    );
    if (!user?.Policy) {
      throw new JellyfinError(`User ${userId} has no policy to update`);
    }
    await this.request<void>('POST', `/Users/${userId}/Policy`, {
      ...user.Policy,
      IsDisabled: disabled,
    });
  }

  // --- Sessions ---

  getSessions(): Promise<JellyfinSession[]> {
    return this.request<JellyfinSession[]>('GET', '/Sessions');
  }

  /** Devices known to the server. Requires admin token. */
  getDevices(): Promise<{
    Items: Array<{
      Id: string;
      Name: string;
      AppName?: string;
      LastUserName?: string;
      DateLastActivity?: string;
    }>;
  }> {
    return this.request('GET', '/Devices');
  }

  // --- Playback control ---

  sendPlaystate(
    sessionId: string,
    command: PlaystateCommand,
    params?: Record<string, string | number>,
  ): Promise<void> {
    return this.request<void>('POST', `/Sessions/${sessionId}/Playing/${command}`, undefined, params);
  }

  /** Seek to absolute position (seconds). */
  seekToSeconds(sessionId: string, seconds: number): Promise<void> {
    return this.sendPlaystate(sessionId, 'Seek', {
      SeekPositionTicks: Math.max(0, Math.round(seconds * TICKS_PER_SECOND)),
    });
  }

  sendCommand(
    sessionId: string,
    name: GeneralCommand,
    args?: Record<string, string | number | boolean>,
  ): Promise<void> {
    return this.request<void>('POST', `/Sessions/${sessionId}/Command`, {
      Name: name,
      Arguments: args ?? {},
    });
  }

  /** Ask a session's client to open an item's detail screen. */
  displayContent(
    sessionId: string,
    item: { id: string; name?: string; type?: string },
  ): Promise<void> {
    return this.request<void>('POST', `/Sessions/${sessionId}/Command`, {
      Name: 'DisplayContent',
      Arguments: {
        ItemId: item.id,
        ItemName: item.name ?? '',
        ItemType: item.type ?? '',
      },
    });
  }

  sendMessage(
    sessionId: string,
    header: string,
    text: string,
    timeoutMs?: number,
  ): Promise<void> {
    return this.request<void>('POST', `/Sessions/${sessionId}/Message`, {
      Header: header,
      Text: text,
      TimeoutMs: timeoutMs,
    });
  }

  /** Tell a session to play an arbitrary list of item IDs. */
  playItemsOnSession(
    sessionId: string,
    itemIds: string[],
    opts: { playCommand?: 'PlayNow' | 'PlayNext' | 'PlayLast'; startPositionTicks?: number } = {},
  ): Promise<void> {
    return this.request<void>('POST', `/Sessions/${sessionId}/Playing`, undefined, {
      itemIds: itemIds.join(','),
      playCommand: opts.playCommand ?? 'PlayNow',
      startPositionTicks: opts.startPositionTicks,
    });
  }

  /** Clear the current play queue of a session. */
  clearSessionQueue(sessionId: string): Promise<void> {
    // No first-class endpoint; play an empty-on-stop sequence by sending Stop.
    // The Jellyfin web client clears the queue by issuing Stop followed by a
    // new PlayNow with the desired items. This helper just stops playback.
    return this.sendPlaystate(sessionId, 'Stop');
  }

  /**
   * Media segments (intro/outro/recap/preview/commercial markers) of an item,
   * ticks converted to seconds. Servers below 10.9 don't have the endpoint —
   * a 404 yields an empty array instead of an error.
   */
  async getMediaSegments(itemId: string): Promise<MediaSegment[]> {
    try {
      const res = await this.request<{
        Items?: Array<{ Type?: string; StartTicks?: number; EndTicks?: number }>;
      }>('GET', `/MediaSegments/${itemId}`);
      return (res?.Items ?? []).map((s) => ({
        type: s.Type ?? '',
        startSeconds: typeof s.StartTicks === 'number' ? s.StartTicks / TICKS_PER_SECOND : 0,
        endSeconds: typeof s.EndTicks === 'number' ? s.EndTicks / TICKS_PER_SECOND : 0,
      }));
    } catch (err) {
      if (err instanceof JellyfinError && err.status === 404) return [];
      throw err;
    }
  }

  /** Item details (incl. Chapters / MediaStreams). */
  getItem(userId: string, itemId: string, fields = 'Chapters,MediaStreams,Overview,ParentId,ProductionYear,UserData'): Promise<NowPlayingItem & LatestItem> {
    return this.request('GET', `/Users/${userId}/Items/${itemId}`, undefined, { Fields: fields });
  }

  // --- Library ---

  getItemCounts(userId?: string): Promise<ItemCounts> {
    return this.request<ItemCounts>('GET', '/Items/Counts', undefined, { userId });
  }

  getLatestItems(opts: {
    userId: string;
    limit?: number;
    parentId?: string;
    includeItemTypes?: string;
  }): Promise<LatestItem[]> {
    return this.request<LatestItem[]>('GET', `/Users/${opts.userId}/Items/Latest`, undefined, {
      Limit: opts.limit ?? 20,
      ParentId: opts.parentId,
      IncludeItemTypes: opts.includeItemTypes,
      Fields: 'DateCreated,ParentId,ProductionYear,UserData',
    });
  }

  /** Continue-watching list for the user. */
  getResumeItems(opts: { userId: string; limit?: number }): Promise<{ Items: LatestItem[]; TotalRecordCount: number }> {
    return this.request('GET', `/Users/${opts.userId}/Items/Resume`, undefined, {
      Limit: opts.limit ?? 20,
      Fields: 'DateCreated,ParentId,ProductionYear,UserData',
      MediaTypes: 'Video',
    });
  }

  /** Free-text search returning items matching the query. */
  searchItems(opts: {
    userId: string;
    searchTerm: string;
    limit?: number;
    includeItemTypes?: string;
  }): Promise<{ Items: LatestItem[]; TotalRecordCount: number }> {
    return this.request('GET', `/Users/${opts.userId}/Items`, undefined, {
      searchTerm: opts.searchTerm,
      Recursive: 'true',
      Limit: opts.limit ?? 20,
      IncludeItemTypes: opts.includeItemTypes,
      Fields: 'ProductionYear,ParentId',
    });
  }

  /** Pick N random items of a given type, optionally filtered by genre/library. */
  getRandomItems(opts: {
    userId: string;
    limit?: number;
    includeItemTypes?: string;
    parentId?: string;
    genres?: string;
    years?: string;
  }): Promise<{ Items: LatestItem[]; TotalRecordCount: number }> {
    return this.request('GET', `/Users/${opts.userId}/Items`, undefined, {
      Recursive: 'true',
      Limit: opts.limit ?? 1,
      SortBy: 'Random',
      IncludeItemTypes: opts.includeItemTypes,
      ParentId: opts.parentId,
      Genres: opts.genres,
      Years: opts.years,
      Fields: 'ProductionYear,ParentId',
    });
  }

  /** All genres the user can pick from (for autocomplete). */
  getGenres(opts: { userId: string; includeItemTypes?: string }): Promise<{ Items: Array<{ Id: string; Name: string }> }> {
    return this.request('GET', '/Genres', undefined, {
      userId: opts.userId,
      IncludeItemTypes: opts.includeItemTypes,
    });
  }

  /** All playlists owned by a user. */
  getPlaylists(userId: string): Promise<{ Items: LatestItem[]; TotalRecordCount: number }> {
    return this.request('GET', `/Users/${userId}/Items`, undefined, {
      Recursive: 'true',
      IncludeItemTypes: 'Playlist',
      Fields: 'ChildCount',
    });
  }

  /** Create a new playlist. Returns the new playlist Id. */
  async createPlaylist(opts: { userId: string; name: string; itemIds?: string[] }): Promise<string> {
    const res = await this.request<{ Id: string }>('POST', '/Playlists', undefined, {
      Name: opts.name,
      UserId: opts.userId,
      Ids: opts.itemIds?.join(',') ?? '',
    });
    return res?.Id ?? '';
  }

  /** Append items to an existing playlist. */
  addToPlaylist(playlistId: string, userId: string, itemIds: string[]): Promise<void> {
    return this.request<void>('POST', `/Playlists/${playlistId}/Items`, undefined, {
      ids: itemIds.join(','),
      userId,
    });
  }

  /** Playlists and collections (BoxSets), name-sorted, for autocomplete/play-on. */
  async getPlaylistsAndCollections(userId?: string): Promise<LatestItem[]> {
    const res = await this.request<{ Items?: LatestItem[] }>('GET', '/Items', undefined, {
      Recursive: 'true',
      IncludeItemTypes: 'Playlist,BoxSet',
      SortBy: 'SortName',
      userId,
      Fields: 'ChildCount',
    });
    return res?.Items ?? [];
  }

  /**
   * Ids of the playable items inside a playlist/collection/folder. Playlist
   * children keep their curated order — the server only returns that when no
   * SortBy is requested — everything else is sorted by SortName.
   */
  async getPlayableChildIds(parentId: string): Promise<string[]> {
    let isPlaylist = false;
    try {
      const parent = await this.request<{ Items?: Array<{ Id: string; Type?: string }> }>(
        'GET',
        '/Items',
        undefined,
        { Ids: parentId },
      );
      isPlaylist = parent?.Items?.[0]?.Type === 'Playlist';
    } catch {
      // Type lookup failed — fall back to name-sorted children.
    }
    const res = await this.request<{ Items?: Array<{ Id: string }> }>('GET', '/Items', undefined, {
      ParentId: parentId,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode,Audio,Video',
      SortBy: isPlaylist ? undefined : 'SortName',
    });
    return (res?.Items ?? []).map((i) => i.Id);
  }

  getMediaFolders(): Promise<{ Items: MediaFolder[] }> {
    return this.request('GET', '/Library/MediaFolders');
  }

  refreshLibrary(itemId?: string): Promise<void> {
    if (itemId) {
      return this.request<void>('POST', `/Items/${itemId}/Refresh`, undefined, {
        Recursive: 'true',
        ImageRefreshMode: 'Default',
        MetadataRefreshMode: 'Default',
      });
    }
    return this.request<void>('POST', '/Library/Refresh');
  }

  /** Mark item as played / unplayed for a user. */
  setPlayed(userId: string, itemId: string, played: boolean): Promise<void> {
    return this.request<void>(
      played ? 'POST' : 'DELETE',
      `/Users/${userId}/PlayedItems/${itemId}`,
    );
  }

  /** Mark / unmark a favorite for a user. */
  setFavorite(userId: string, itemId: string, favorite: boolean): Promise<void> {
    return this.request<void>(
      favorite ? 'POST' : 'DELETE',
      `/Users/${userId}/FavoriteItems/${itemId}`,
    );
  }

  /** Number of unplayed items for a user filtered by type, e.g. Episode. */
  async getUnplayedCount(userId: string, includeItemTypes = 'Episode'): Promise<number> {
    const res = await this.request<{ TotalRecordCount: number }>(
      'GET',
      `/Users/${userId}/Items`,
      undefined,
      {
        Recursive: 'true',
        Limit: 0,
        IncludeItemTypes: includeItemTypes,
        Filters: 'IsUnplayed',
      },
    );
    return res?.TotalRecordCount ?? 0;
  }

  // --- Server admin (admin token required) ---

  restartServer(): Promise<void> {
    return this.request<void>('POST', '/System/Restart');
  }

  shutdownServer(): Promise<void> {
    return this.request<void>('POST', '/System/Shutdown');
  }

  getSystemInfoFull(): Promise<SystemInfoFull> {
    return this.request<SystemInfoFull>('GET', '/System/Info');
  }

  /** Lightweight ping (returns string "Healthy" or similar). */
  ping(): Promise<string> {
    return this.request<string>('GET', '/System/Ping');
  }

  /** Non-hidden scheduled tasks (compact projection). */
  async getScheduledTasks(): Promise<ScheduledTaskSummary[]> {
    const res = await this.request<
      Array<{ Id: string; Name: string; Category?: string; State?: string }>
    >('GET', '/ScheduledTasks', undefined, { isHidden: 'false' });
    return (res ?? []).map((t) => ({
      id: t.Id,
      name: t.Name,
      category: t.Category,
      state: t.State ?? '',
    }));
  }

  /** Kicks off a scheduled task by id. */
  startScheduledTask(taskId: string): Promise<void> {
    return this.request<void>('POST', `/ScheduledTasks/Running/${taskId}`);
  }

  /** Single scheduled task incl. last-run status; null when the id is unknown. */
  async getScheduledTask(
    taskId: string,
  ): Promise<{ id: string; name: string; state: string; lastResultStatus?: string } | null> {
    try {
      const t = await this.request<{
        Id: string;
        Name: string;
        State?: string;
        LastExecutionResult?: { Status?: string };
      }>('GET', `/ScheduledTasks/${taskId}`);
      if (!t) return null;
      return {
        id: t.Id,
        name: t.Name,
        state: t.State ?? '',
        lastResultStatus: t.LastExecutionResult?.Status,
      };
    } catch (err) {
      if (err instanceof JellyfinError && err.status === 404) return null;
      throw err;
    }
  }

  /** Whether the server reports an available update (HasUpdateAvailable). */
  async getUpdateAvailable(): Promise<boolean> {
    const info = await this.request<{ HasUpdateAvailable?: boolean }>('GET', '/System/Info');
    return info?.HasUpdateAvailable === true;
  }

  // --- Image URLs + cache ---

  imageUrl(itemId: string, type = 'Primary', tag?: string, maxHeight = 600): string {
    const url = new URL(`${this.baseUrl}/Items/${itemId}/Images/${type}`);
    url.searchParams.set('maxHeight', String(maxHeight));
    if (tag) url.searchParams.set('tag', tag);
    // Image endpoints are normally anonymous, but some Jellyfin forks /
    // configurations gate them behind auth. The query-param form is the
    // officially documented way to authenticate image requests.
    url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  /**
   * Fetches an image once, then serves from an LRU cache. Used by Homey
   * Image setStream() handlers so we don't hit the Jellyfin server every
   * time a widget repaints.
   */
  async getCachedImage(url: string): Promise<CachedImage | undefined> {
    if (!url) return undefined;
    const now = Date.now();
    const hit = this.imageCache.get(url);
    if (hit && now - hit.fetchedAt < JellyfinClient.IMAGE_CACHE_TTL_MS) {
      this.imageCache.delete(url);
      this.imageCache.set(url, hit);
      return hit;
    }
    try {
      const raw = await this.fetchRaw(new URL(url), { method: 'GET' }, 15_000);
      if (raw.status < 200 || raw.status >= 300) return undefined;
      const entry: CachedImage = {
        buffer: raw.body,
        contentType: raw.contentType || 'image/jpeg',
        fetchedAt: now,
      };
      this.imageCache.set(url, entry);
      while (this.imageCache.size > JellyfinClient.IMAGE_CACHE_MAX) {
        const firstKey = this.imageCache.keys().next().value;
        if (firstKey === undefined) break;
        this.imageCache.delete(firstKey);
      }
      return entry;
    } catch {
      return undefined;
    }
  }
}
