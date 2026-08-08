import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerHub } from '../lib/ServerHub';
import type { TimerProvider } from '../lib/JellyfinSocket';

// Exercise the feature-phase hub contracts without touching the network: a
// ServerHub only connects in start() (never called here), so the private
// handlers can be driven directly and the client methods stubbed, in the same
// style as server-hub-events.test.ts.

type HubInternals = {
  handleActivityLog(entries: unknown[]): void;
  maybeCheckUpdate(): Promise<void>;
  socketOpen: boolean;
  lastUpdateCheckAt: number;
};

function makeHub(timers?: TimerProvider): ServerHub {
  return new ServerHub({
    baseUrl: 'http://127.0.0.1:8096',
    apiKey: 'test-key',
    serverId: 'srv1',
    userId: 'user-default',
    homeyDeviceId: 'homey-test',
    appVersion: '0.0.0',
    timers,
  });
}

/**
 * Manual timer provider: callbacks are captured and only run when flush() is
 * called, so the task-monitor poll loop can be stepped deterministically.
 */
function makeManualTimers(): { timers: TimerProvider; flush: () => Promise<void>; pendingCount: () => number } {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const timers: TimerProvider = {
    setTimeout: (cb, _ms) => {
      const id = nextId++;
      pending.set(id, cb);
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout: (t) => {
      pending.delete(t as unknown as number);
    },
    setInterval: (cb, _ms) => {
      const id = nextId++;
      pending.set(id, cb);
      return id as unknown as NodeJS.Timeout;
    },
    clearInterval: (t) => {
      pending.delete(t as unknown as number);
    },
  };
  const flush = async (): Promise<void> => {
    const cbs = [...pending.values()];
    pending.clear();
    for (const cb of cbs) cb();
    // Let the async continuations behind the callbacks (stubbed client calls
    // resolving on the microtask queue) settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { timers, flush, pendingCount: () => pending.size };
}

test('activity:auth_failed is rate-limited to 5 emits per minute (H2)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const emits: Array<{ userName: string }> = [];
  hub.on('activity:auth_failed', (d: { userName: string }) => emits.push(d));
  try {
    const entries = Array.from({ length: 8 }, () => ({
      Type: 'AuthenticationFailed',
      Name: 'Failed login attempt made by eve.',
      Severity: 'Error',
    }));
    h.handleActivityLog(entries);
    assert.equal(emits.length, 5, 'excess auth_failed events must be dropped');
    assert.equal(emits[0].userName, 'eve');
    // Still within the same minute: further entries stay dropped.
    h.handleActivityLog([{ Type: 'AuthenticationFailed', Name: 'Failed login attempt made by eve.' }]);
    assert.equal(emits.length, 5);
  } finally {
    await hub.stop();
  }
});

test('server:update_available fires only on the false→true transition (H3)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const emits: unknown[] = [];
  hub.on('server:update_available', (d: unknown) => emits.push(d));
  let available = true;
  hub.client.getUpdateAvailable = async () => available;
  try {
    // Socket down: no check at all, even though an update is available.
    h.socketOpen = false;
    await h.maybeCheckUpdate();
    assert.equal(emits.length, 0, 'must not check while disconnected');

    // Connected: first check sees true → exactly one emit.
    h.socketOpen = true;
    await h.maybeCheckUpdate();
    assert.equal(emits.length, 1);

    // Still true on the next check: no repeat emit.
    h.lastUpdateCheckAt = 0;
    await h.maybeCheckUpdate();
    assert.equal(emits.length, 1, 'a persistent update must not re-fire');

    // Back to false, then true again: fires once more.
    available = false;
    h.lastUpdateCheckAt = 0;
    await h.maybeCheckUpdate();
    available = true;
    h.lastUpdateCheckAt = 0;
    await h.maybeCheckUpdate();
    assert.equal(emits.length, 2);

    // Throttled: without resetting lastUpdateCheckAt nothing is checked, so a
    // flip to false goes unseen and cannot arm another transition.
    available = false;
    await h.maybeCheckUpdate();
    available = true;
    h.lastUpdateCheckAt = 0;
    await h.maybeCheckUpdate();
    assert.equal(emits.length, 2, 'a throttled check must not observe state');
  } finally {
    await hub.stop();
  }
});

test('runScheduledTask emits task:completed after the state returns to Idle (H4)', async () => {
  const { timers, flush, pendingCount } = makeManualTimers();
  const hub = makeHub(timers);
  const completed: Array<{ taskId: string; taskName: string; status: string }> = [];
  hub.on('task:completed', (d: { taskId: string; taskName: string; status: string }) =>
    completed.push(d),
  );
  let state = 'Running';
  hub.client.startScheduledTask = async () => undefined;
  hub.client.getScheduledTask = async (taskId: string) => ({
    id: taskId,
    name: 'Scan Media Library',
    state,
    lastResultStatus: state === 'Idle' ? 'Completed' : undefined,
  });
  try {
    await hub.runScheduledTask('task-1');
    assert.equal(completed.length, 0, 'nothing completes before the first poll');
    assert.equal(pendingCount(), 1, 'a poll must be scheduled');

    await flush(); // first poll: still Running → reschedules
    assert.equal(completed.length, 0);
    assert.equal(pendingCount(), 1, 'monitoring must continue while Running');

    state = 'Idle';
    await flush(); // second poll: Idle → completed
    assert.deepEqual(completed, [
      { taskId: 'task-1', taskName: 'Scan Media Library', status: 'Completed' },
    ]);
    assert.equal(pendingCount(), 0, 'monitoring must stop after completion');
  } finally {
    await hub.stop();
  }
});

test('stop() aborts a running task monitor (H4)', async () => {
  const { timers, flush, pendingCount } = makeManualTimers();
  const hub = makeHub(timers);
  const completed: unknown[] = [];
  hub.on('task:completed', (d: unknown) => completed.push(d));
  hub.client.startScheduledTask = async () => undefined;
  hub.client.getScheduledTask = async (taskId: string) => ({
    id: taskId,
    name: 'Scan Media Library',
    state: 'Idle',
    lastResultStatus: 'Completed',
  });
  await hub.runScheduledTask('task-1');
  assert.equal(pendingCount(), 1);
  await hub.stop();
  assert.equal(pendingCount(), 0, 'stop() must clear the pending monitor timer');
  await flush();
  assert.equal(completed.length, 0, 'no completion may fire after stop()');
});
