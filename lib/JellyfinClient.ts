import { URL } from 'url';

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  deviceName?: string;
  clientName?: string;
  appVersion?: string;
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
  };
  NowPlayingItem?: NowPlayingItem;
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
  | 'DisplayMessage';

export class JellyfinError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'JellyfinError';
  }
}

export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;
  private deviceId: string;
  private deviceName: string;
  private clientName: string;
  private appVersion: string;

  constructor(opts: JellyfinClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.deviceId = opts.deviceId;
    this.deviceName = opts.deviceName ?? 'Homey';
    this.clientName = opts.clientName ?? 'Homeyfin';
    this.appVersion = opts.appVersion ?? '0.1.0';
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

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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

  /**
   * Returns devices (clients) known to the server. Requires admin token.
   */
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
      Fields: 'DateCreated,ParentId,ProductionYear',
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

  // --- Image URLs (no auth needed for image endpoint, but token doesn't hurt) ---

  imageUrl(itemId: string, type = 'Primary', tag?: string, maxHeight = 600): string {
    const url = new URL(`${this.baseUrl}/Items/${itemId}/Images/${type}`);
    url.searchParams.set('maxHeight', String(maxHeight));
    if (tag) url.searchParams.set('tag', tag);
    return url.toString();
  }
}
