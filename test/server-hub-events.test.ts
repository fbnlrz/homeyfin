import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerHub } from '../lib/ServerHub';
import type { JellyfinSession, NowPlayingItem } from '../lib/JellyfinClient';

// These exercise the stateful handleSessions() event fan-out, guarding the
// regressions found in review: state maps were overwritten *before* the event
// loop read the previous now-playing item, which silently killed the
// transcoding triggers and the user/client "stopped" triggers. A ServerHub can
// be constructed without touching the network (the socket only connects in
// start(), which we never call), so we can drive handleSessions directly.

type HubInternals = {
  handleSessions(sessions: JellyfinSession[], dispatchedAt?: number): void;
};

function makeHub(): ServerHub {
  return new ServerHub({
    baseUrl: 'http://127.0.0.1:8096',
    apiKey: 'test-key',
    serverId: 'srv1',
    userId: 'user-default',
    homeyDeviceId: 'homey-test',
    appVersion: '0.0.0',
  });
}

const MOVIE: NowPlayingItem = { Id: 'item1', Name: 'The Matrix', Type: 'Movie' };

function session(overrides: Partial<JellyfinSession> = {}): JellyfinSession {
  return {
    Id: 'sess1',
    DeviceId: 'dev1',
    DeviceName: 'Living Room TV',
    Client: 'Jellyfin Web',
    UserId: 'user1',
    UserName: 'Alice',
    PlayState: {},
    ...overrides,
  };
}

test('user playback_stopped carries the item that was playing (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const stopped: Array<NowPlayingItem | undefined> = [];
  hub.on('user:user1:playback_stopped', (_snap: unknown, item: NowPlayingItem | undefined) =>
    stopped.push(item),
  );
  try {
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 1000);
    // Same session, playback stopped (NowPlayingItem cleared, device still present).
    h.handleSessions([session({ NowPlayingItem: undefined })], 2000);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]?.Name, 'The Matrix');
  } finally {
    await hub.stop();
  }
});

test('client playback_stopped carries the item that was playing (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const stopped: Array<NowPlayingItem | undefined> = [];
  hub.on('client:dev1:playback_stopped', (_snap: unknown, item: NowPlayingItem | undefined) =>
    stopped.push(item),
  );
  try {
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 1000);
    h.handleSessions([session({ NowPlayingItem: undefined })], 2000);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]?.Name, 'The Matrix');
  } finally {
    await hub.stop();
  }
});

test('transcoding:started and transcoding:stopped fire on transitions (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const started: Array<{ title: string }> = [];
  const stopped: Array<{ title: string }> = [];
  hub.on('transcoding:started', (d: { title: string }) => started.push(d));
  hub.on('transcoding:stopped', (d: { title: string }) => stopped.push(d));
  try {
    // Playing, direct play.
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 1000);
    // Same item now transcoding.
    h.handleSessions(
      [session({ NowPlayingItem: MOVIE, TranscodingInfo: { TranscodeReasons: ['VideoCodecNotSupported'] } })],
      2000,
    );
    // Back to direct play.
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 3000);
    assert.deepEqual(started.map((d) => d.title), ['The Matrix']);
    assert.deepEqual(stopped.map((d) => d.title), ['The Matrix']);
  } finally {
    await hub.stop();
  }
});

test('a stale out-of-order sessions frame is dropped (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const stopped: number[] = [];
  hub.on('user:user1:playback_stopped', () => stopped.push(1));
  try {
    // Newer frame (dispatched at 2000) applied first: Alice is playing.
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 2000);
    // Stale frame (dispatched at 1000) resolves late with Alice idle: must drop.
    h.handleSessions([session({ NowPlayingItem: undefined })], 1000);
    assert.equal(stopped.length, 0, 'a superseded frame must not fire a stop');
    assert.ok(hub.getUserSnapshot('user1')?.nowPlaying, 'state should still reflect the newer frame');
  } finally {
    await hub.stop();
  }
});

test('no user:logged_in on the first pass; genuine logins still fire (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const logins: Array<{ user?: string }> = [];
  hub.on('user:logged_in', (d: { user?: string }) => logins.push(d));
  try {
    // First pass: Alice already connected — must not fire on startup.
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 1000);
    assert.equal(logins.length, 0, 'already-connected sessions must not fire logged_in on startup');
    // Second pass: Bob newly appears — must fire once.
    h.handleSessions(
      [
        session({ NowPlayingItem: MOVIE }),
        session({
          Id: 'sess2',
          DeviceId: 'dev2',
          DeviceName: 'Phone',
          Client: 'Jellyfin Mobile',
          UserId: 'user2',
          UserName: 'Bob',
        }),
      ],
      2000,
    );
    assert.deepEqual(logins.map((d) => d.user), ['Bob']);
  } finally {
    await hub.stop();
  }
});
