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
  UserData?: { Played?: boolean; IsFavorite?: boolean; UnplayedItemCount?: number };
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
  | 'DisplayMessage';

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
    return (
      `MediaBrowser Client="${this.clientName}", ` +
      `Device="${this.deviceName}", ` +
      `DeviceId="${this.deviceId}", ` +
      `Version="${this.appVersion}", ` +
      `Token="${this.apiKey}"`
    );
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

    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    // Node's global fetch (undici) uses dispatcher, not agent — best-effort fallback.
    if (this.insecureAgent && url.protocol === 'https:') {
      (init as any).agent = this.insecureAgent;
    }

    const res = await fetch(url.toString(), init);

    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // ignore
      }
      throw new JellyfinError(
        `Jellyfin ${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`,
        res.status,
      );
    }

    if (res.status === 204) return undefined as unknown as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  // --- Discovery / auth ---

  getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('GET', '/System/Info');
  }

  getUsers(): Promise<JellyfinUser[]> {
    return this.request<JellyfinUser[]>('GET', '/Users');
  }

  // --- Sessions ---

  getSessions(): Promise<JellyfinSession[]> {
    return this.request<JellyfinSession[]>('GET', '/Sessions');
  }

  /** Devices known to the server. Requires admin token. */
  getDevices(): Promise<{ Items: Array<{ Id: string; Name: string; AppName?: string; LastUserName?: string }> }> {
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

  // --- Image URLs + cache ---

  imageUrl(itemId: string, type = 'Primary', tag?: string, maxHeight = 600): string {
    const url = new URL(`${this.baseUrl}/Items/${itemId}/Images/${type}`);
    url.searchParams.set('maxHeight', String(maxHeight));
    if (tag) url.searchParams.set('tag', tag);
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
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const ct = res.headers.get('content-type') ?? 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      const entry: CachedImage = { buffer: buf, contentType: ct, fetchedAt: now };
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
