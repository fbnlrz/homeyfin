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

test('does not emit stopped while device is offline (kept-as-last)', () => {
  const item = makeItem('item-1');
  const prev = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: item, online: true })],
  ]);
  const next = new Map<string, ClientSnapshot>([
    ['d1', snap('d1', { nowPlaying: undefined, online: false })],
  ]);
  // Per the spec, an offline (no longer in /Sessions but kept by us) device
  // still surfaces a stopped event via the "device disappeared" path. Here
  // both maps still contain the device, so the "stay-online" branch fires.
  const events = ServerHub.diffSessions(prev, next);
  // With online:false, the "started" branch skips because nx.online is false,
  // and the "stopped" branch fires only when nx.online is true. So we expect
  // exactly one event from the disappeared-prev branch... but it's still in
  // next, so 0 events.
  assert.deepEqual(events, []);
});
