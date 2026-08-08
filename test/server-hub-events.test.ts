import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerHub } from '../lib/ServerHub';
import type { JellyfinSession, LatestItem, NowPlayingItem } from '../lib/JellyfinClient';

// These exercise the stateful handleSessions() event fan-out, guarding the
// regressions found in review: state maps were overwritten *before* the event
// loop read the previous now-playing item, which silently killed the
// transcoding triggers and the user/client "stopped" triggers. A ServerHub can
// be constructed without touching the network (the socket only connects in
// start(), which we never call), so we can drive handleSessions directly.

type HubInternals = {
  handleSessions(sessions: JellyfinSession[], dispatchedAt?: number): void;
  refreshLibrary(): Promise<void>;
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

test('a live session lookup does not swallow the next started trigger (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const started: string[] = [];
  hub.on('user:user1:playback_started', () => started.push('user'));
  hub.on('client:dev1:playback_started', () => started.push('client'));
  hub.on(`clientapp:${ServerHub.appKey('Jellyfin Web', 'user1')}:playback_started`, () =>
    started.push('app'),
  );
  try {
    // Baseline: Alice's device connected but idle.
    h.handleSessions([session()], 1000);
    // A remote-control command triggers live lookups while playback has just
    // begun server-side. These must only fill the TTL caches — writing into the
    // last*Snapshots baseline maps made the subsequent diff see "already
    // playing" and drop the started/changed transitions entirely.
    hub.client.getSessions = async () => [session({ NowPlayingItem: MOVIE })];
    await hub.getLiveUserSession('user1');
    await hub.getLiveClientSession('dev1');
    await hub.getLiveClientSessionByApp('Jellyfin Web', 'user1');
    assert.equal(started.length, 0, 'live lookups themselves must not emit');
    // The next sessions frame reports the same playback — started must fire.
    h.handleSessions([session({ NowPlayingItem: MOVIE })], 2000);
    assert.deepEqual(started.sort(), ['app', 'client', 'user']);
  } finally {
    await hub.stop();
  }
});

test('a failed first library refresh does not cause a new_item burst later (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const movie = (id: string): LatestItem => ({ Id: id, Name: id, Type: 'Movie' });
  const newItems: Array<{ item: LatestItem; libraryId: string; libraryName: string }> = [];
  hub.on('library:new_item', (ev: { item: LatestItem; libraryId: string; libraryName: string }) =>
    newItems.push(ev),
  );
  const client = hub.client as unknown as {
    getItemCounts: (userId?: string) => Promise<unknown>;
    getMediaFolders: () => Promise<{ Items: Array<{ Id: string; Name: string }> }>;
    getLatestItems: (opts: { userId: string; parentId?: string }) => Promise<LatestItem[]>;
  };
  client.getItemCounts = () => Promise.reject(new Error('server down'));
  client.getMediaFolders = async () => ({ Items: [{ Id: 'lib-movies', Name: 'Movies' }] });
  try {
    // First refresh fails: must NOT bootstrap an empty baseline.
    client.getLatestItems = () => Promise.reject(new Error('server down'));
    await h.refreshLibrary();
    // Next refresh succeeds: this establishes the baseline — silently. Before
    // the fix, the failed run had already bootstrapped with [], so every one of
    // these items would have fired as a "new" item now.
    client.getLatestItems = async () => [movie('m1'), movie('m2')];
    await h.refreshLibrary();
    assert.equal(newItems.length, 0, 'baseline items must not fire new_item');
    // A genuinely new item fires exactly once, with its library attribution.
    client.getLatestItems = async () => [movie('m3'), movie('m1'), movie('m2')];
    await h.refreshLibrary();
    assert.equal(newItems.length, 1);
    assert.equal(newItems[0].item.Id, 'm3');
    assert.equal(newItems[0].libraryId, 'lib-movies');
    assert.equal(newItems[0].libraryName, 'Movies');
  } finally {
    await hub.stop();
  }
});

test('no spurious user:logged_in after a one-frame session gap (regression)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const logins: Array<{ user?: string }> = [];
  hub.on('user:logged_in', (d: { user?: string }) => logins.push(d));
  try {
    // Bootstrap pass: Alice connected.
    h.handleSessions([session()], 1000);
    // One dropped /Sessions frame: the device is grace-held, so its session key
    // must stay known — before the fix knownSessionKeys was replaced by the
    // (empty) seen set and the reappearance fired logged_in again.
    h.handleSessions([], 2000);
    h.handleSessions([session()], 3000);
    assert.equal(logins.length, 0, 'a grace-held blip must not re-fire logged_in');
  } finally {
    await hub.stop();
  }
});
