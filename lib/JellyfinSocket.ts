import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { URL } from 'url';

export interface JellyfinSocketOptions {
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  /** When true, log verbose debug info via console.log */
  debug?: boolean;
  /** Accept self-signed TLS certs on the WebSocket (LAN servers). */
  insecureTls?: boolean;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export interface JellyfinSocketEvents {
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
  /** Raw inbound message frame */
  message: (msg: { MessageType: string; Data?: unknown }) => void;
  /** Convenience: parsed Sessions snapshot from SessionsStart subscription */
  sessions: (data: unknown[]) => void;
  libraryChanged: (data: unknown) => void;
  userDataChanged: (data: unknown) => void;
  activityLogEntry: (data: unknown[]) => void;
  scheduledTaskEnded: (data: unknown) => void;
}

export declare interface JellyfinSocket {
  on<K extends keyof JellyfinSocketEvents>(event: K, listener: JellyfinSocketEvents[K]): this;
  emit<K extends keyof JellyfinSocketEvents>(
    event: K,
    ...args: Parameters<JellyfinSocketEvents[K]>
  ): boolean;
}

export class JellyfinSocket extends EventEmitter {
  private ws?: WebSocket;
  private keepAliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private stopped = false;

  constructor(private readonly opts: JellyfinSocketOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearKeepAlive();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = undefined;
    }
  }

  private connect(): void {
    const httpUrl = new URL(this.opts.baseUrl);
    const wsProto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${httpUrl.host}${httpUrl.pathname.replace(/\/$/, '')}/socket?api_key=${encodeURIComponent(
      this.opts.apiKey,
    )}&deviceId=${encodeURIComponent(this.opts.deviceId)}`;

    if (this.opts.debug) console.log('[JellyfinSocket] connecting', wsUrl.replace(this.opts.apiKey, '***'));

    const ws = new WebSocket(wsUrl, {
      rejectUnauthorized: !this.opts.insecureTls,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.retryAttempt = 0;
      if (this.opts.debug) console.log('[JellyfinSocket] open');
      this.send({ MessageType: 'SessionsStart', Data: '0,1500' });
      this.send({ MessageType: 'ActivityLogEntryStart', Data: '0,1500' });
      this.startKeepAlive();
      this.emit('open');
    });

    ws.on('message', (raw) => {
      let msg: { MessageType?: string; Data?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.emit('error', new Error('Invalid JSON from Jellyfin socket'));
        return;
      }
      if (!msg.MessageType) return;
      this.emit('message', msg as { MessageType: string; Data?: unknown });

      switch (msg.MessageType) {
        case 'Sessions':
          if (Array.isArray(msg.Data)) this.emit('sessions', msg.Data as unknown[]);
          break;
        case 'LibraryChanged':
          this.emit('libraryChanged', msg.Data);
          break;
        case 'UserDataChanged':
          this.emit('userDataChanged', msg.Data);
          break;
        case 'ActivityLogEntry':
          if (Array.isArray(msg.Data)) this.emit('activityLogEntry', msg.Data as unknown[]);
          break;
        case 'ScheduledTaskEnded':
          this.emit('scheduledTaskEnded', msg.Data);
          break;
        case 'ForceKeepAlive':
          // Server-driven keepalive interval (in seconds). Just keep our own going.
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (this.opts.debug) console.log('[JellyfinSocket] close');
      this.clearKeepAlive();
      this.emit('close');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.opts.debug) console.log('[JellyfinSocket] error', err.message);
      this.emit('error', err);
      // 'close' will follow and trigger reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.retryAttempt, BACKOFF_MS.length - 1)];
    this.retryAttempt += 1;
    if (this.opts.debug) console.log('[JellyfinSocket] reconnect in', delay, 'ms');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startKeepAlive(): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.send({ MessageType: 'KeepAlive' });
    }, 30_000);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.emit('error', err as Error);
      }
    }
  }
}
