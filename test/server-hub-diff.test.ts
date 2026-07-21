import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerHub, ClientSnapshot } from '../lib/ServerHub';
import type { NowPlayingItem } from '../lib/JellyfinClient';

function makeItem(id: string): NowPlayingItem {
  return { Id: id, Name: id, Type: 'Episode' };
}

function snap(deviceId: string, opts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return {
    deviceId,
    sessionId: `${deviceId}-session`,
    clientName: 'TestClient',
    deviceName: deviceId,
    userName: 'tester',
    online: true,
    isPaused: false,
    isMuted: false,
    ...opts,
  };
}

test('emits "started" + "changed" when playback begins on a new client', () => {
  const prev = new Map<string, ClientSnapshot>();
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('item-1') })],
  ]);
  const events = ServerHub.diffSessions(prev, next);
  const types = events.filter((e) => e.deviceId === 'd1').map((e) => e.type);
  assert.deepEqual(types, ['started', 'changed']);
});

test('emits "stopped" when nowPlaying disappears but device stays online', () => {
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('item-1') })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: undefined })],
  ]);
  const events = ServerHub.diffSessions(prev, next);
  assert.deepEqual(events, [{ deviceId: 'd1', type: 'stopped' }]);
});

test('emits "stopped" when device disappears entirely', () => {
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('item-1') })],
  ]);
  const next = new Map<string, ClientSnapshot>();
  const events = ServerHub.diffSessions(prev, next);
  assert.deepEqual(events, [{ deviceId: 'd1', type: 'stopped' }]);
});

test('emits "paused" and "resumed" on isPaused transitions', () => {
  const item = makeItem('item-1');
  const playing = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, isPaused: false })],
  ]);
  const paused = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, isPaused: true })],
  ]);

  assert.deepEqual(
    ServerHub.diffSessions(playing, paused),
    [{ deviceId: 'd1', type: 'paused' }],
  );
  assert.deepEqual(
    ServerHub.diffSessions(paused, playing),
    [{ deviceId: 'd1', type: 'resumed' }],
  );
});

test('emits "changed" + "started" when item id swaps mid-session (next episode)', () => {
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('item-1') })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('item-2') })],
  ]);
  const types = ServerHub.diffSessions(prev, next).map((e) => e.type);
  assert.deepEqual(types, ['changed', 'started']);
});

test('emits nothing when state is unchanged', () => {
  const item = makeItem('item-1');
  const state = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, isPaused: false })],
  ]);
  const clone = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, isPaused: false })],
  ]);
  assert.deepEqual(ServerHub.diffSessions(state, clone), []);
});

test('handles multiple devices independently', () => {
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('a') })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: makeItem('a'), isPaused: true })],
    ['d2', snap('d2', { nowPlaying: makeItem('b') })],
  ]);
  const events = ServerHub.diffSessions(prev, next);
  const byDevice = events.reduce<Record<string, string[]>>((acc, e) => {
    (acc[e.deviceId] ??= []).push(e.type);
    return acc;
  }, {});
  assert.deepEqual(byDevice.d1, ['paused']);
  assert.deepEqual(byDevice.d2, ['started', 'changed']);
});

test('emits stopped when a playing device goes offline (kept-as-last)', () => {
  const item = makeItem('item-1');
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, online: true })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: undefined, online: false })],
  ]);
  // Closing a browser tab / killing the app drops the session, and we retain it
  // as an offline snapshot (still present in `next`, online:false, no item).
  // That transition — was playing, now nothing — must surface as a single stop;
  // it is the most common way browser playback ends.
  const events = ServerHub.diffSessions(prev, next);
  assert.deepEqual(events, [{ deviceId: 'd1', type: 'stopped' }]);
});

test('does not emit stopped for an idle device that goes offline', () => {
  // Not playing before, goes offline: no phantom stop.
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: undefined, online: true })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: undefined, online: false })],
  ]);
  assert.deepEqual(ServerHub.diffSessions(prev, next), []);
});

test('pickActiveSnapshot stays pinned to the previously-followed session', () => {
  const a = snap('a', { sessionId: 'sess-a', nowPlaying: makeItem('x'), lastActivityMs: 100 });
  const b = snap('b', { sessionId: 'sess-b', nowPlaying: makeItem('y'), lastActivityMs: 200 });
  // Without a pin, b wins on lastActivityMs; with the pin, a stays selected so
  // two concurrent same-app sessions don't make the Follow-App device flap.
  assert.equal(ServerHub.pickActiveSnapshot([a, b])?.sessionId, 'sess-b');
  assert.equal(ServerHub.pickActiveSnapshot([a, b], 'sess-a')?.sessionId, 'sess-a');
});

test('pickActiveSnapshot yields the pin when it is paused and another is playing', () => {
  const pinnedPaused = snap('a', {
    sessionId: 'sess-a',
    nowPlaying: makeItem('x'),
    isPaused: true,
    lastActivityMs: 100,
  });
  const otherPlaying = snap('b', {
    sessionId: 'sess-b',
    nowPlaying: makeItem('y'),
    isPaused: false,
    lastActivityMs: 50,
  });
  // Pinned-but-paused must not wedge the device while another session plays.
  assert.equal(
    ServerHub.pickActiveSnapshot([pinnedPaused, otherPlaying], 'sess-a')?.sessionId,
    'sess-b',
  );
  // But if nobody else is actively playing, keep the (paused) pin.
  const otherPaused = snap('b', { sessionId: 'sess-b', nowPlaying: makeItem('y'), isPaused: true });
  assert.equal(
    ServerHub.pickActiveSnapshot([pinnedPaused, otherPaused], 'sess-a')?.sessionId,
    'sess-a',
  );
});
