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
  refreshLibrary(): Promise<void>;
  scheduleSocketRefresh(): void;
  scheduleTaskPoll(taskId: string, startedAt: number): void;
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

test('overlapping refreshLibrary runs coalesce and never double-emit new_item (F1)', async () => {
  const hub = makeHub();
  const h = hub as unknown as HubInternals;
  const newItems: string[] = [];
  hub.on('library:new_item', (ev: { item: { Id: string } }) => newItems.push(ev.item.Id));
  const movie = (id: string): { Id: string; Name: string; Type: string } => ({
    Id: id,
    Name: id,
    Type: 'Movie',
  });
  const client = hub.client as unknown as {
    getItemCounts: (userId?: string) => Promise<unknown>;
    getMediaFolders: () => Promise<{ Items: Array<{ Id: string; Name: string }> }>;
    getLatestItems: (opts: unknown) => Promise<unknown[]>;
  };
  client.getItemCounts = () => Promise.reject(new Error('n/a'));
  client.getMediaFolders = async () => ({ Items: [{ Id: 'lib-movies', Name: 'Movies' }] });
  try {
    // Baseline run: bootstraps silently.
    client.getLatestItems = async () => [movie('m1')];
    await h.refreshLibrary();
    assert.equal(newItems.length, 0, 'baseline items must not fire new_item');

    // A second call arrives while the first is stuck fetching latest items —
    // before the guard, both runs saw the old baseline and emitted m2 twice.
    let release!: (items: unknown[]) => void;
    const gate = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    client.getLatestItems = () => {
      fetches++;
      return gate;
    };
    const first = h.refreshLibrary();
    const second = h.refreshLibrary();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1, 'the overlapping call must not fetch in parallel');
    release([movie('m1'), movie('m2')]);
    await Promise.all([first, second]);
    assert.deepEqual(newItems, ['m2'], 'the new item must fire exactly once');
    assert.equal(fetches, 2, 'the deferred follow-up run executes once afterwards');
  } finally {
    await hub.stop();
  }
});

test('socket-triggered library refreshes are debounced into one run (F1)', async () => {
  const { timers, flush, pendingCount } = makeManualTimers();
  const hub = makeHub(timers);
  const h = hub as unknown as HubInternals;
  let refreshes = 0;
  const client = hub.client as unknown as {
    getItemCounts: (userId?: string) => Promise<unknown>;
    getMediaFolders: () => Promise<{ Items: unknown[] }>;
  };
  client.getItemCounts = () => Promise.reject(new Error('n/a'));
  client.getMediaFolders = async () => {
    refreshes++;
    return { Items: [] };
  };
  try {
    // A burst of LibraryChanged frames arms exactly one trailing timer.
    h.scheduleSocketRefresh();
    h.scheduleSocketRefresh();
    h.scheduleSocketRefresh();
    assert.equal(pendingCount(), 1, 'a frame burst must arm a single timer');
    await flush();
    assert.equal(refreshes, 1, 'the burst must collapse into one refresh');
    assert.equal(pendingCount(), 0, 'no timer may stay behind after the refresh');
  } finally {
    await hub.stop();
  }
});

test('a repeated runScheduledTask does not stack a second monitor (F3)', async () => {
  const { timers, flush, pendingCount } = makeManualTimers();
  const hub = makeHub(timers);
  const completed: Array<{ taskId: string; taskName: string; status: string }> = [];
  hub.on('task:completed', (d: { taskId: string; taskName: string; status: string }) =>
    completed.push(d),
  );
  let state = 'Running';
  let starts = 0;
  hub.client.startScheduledTask = async () => {
    starts++;
  };
  hub.client.getScheduledTask = async (taskId: string) => ({
    id: taskId,
    name: 'Scan Media Library',
    state,
    lastResultStatus: state === 'Idle' ? 'Completed' : undefined,
  });
  try {
    await hub.runScheduledTask('task-1');
    await hub.runScheduledTask('task-1');
    assert.equal(starts, 2, 'the task start itself is repeated');
    assert.equal(pendingCount(), 1, 'only one monitor may exist per task id');

    await flush(); // still Running → the single monitor reschedules
    assert.equal(pendingCount(), 1);

    state = 'Idle';
    await flush();
    assert.deepEqual(completed, [
      { taskId: 'task-1', taskName: 'Scan Media Library', status: 'Completed' },
    ]);
    assert.equal(pendingCount(), 0, 'monitoring must stop after completion');

    // After completion the id is free again: a new run starts a new monitor.
    state = 'Running';
    await hub.runScheduledTask('task-1');
    assert.equal(pendingCount(), 1, 'a fresh run may monitor again');
  } finally {
    await hub.stop();
  }
});

test('task monitor reports TimedOut after the horizon instead of going silent (V2)', async () => {
  const { timers, flush, pendingCount } = makeManualTimers();
  const hub = makeHub(timers);
  const h = hub as unknown as HubInternals;
  const completed: Array<{ taskId: string; taskName: string; status: string }> = [];
  hub.on('task:completed', (d: { taskId: string; taskName: string; status: string }) =>
    completed.push(d),
  );
  hub.client.getScheduledTask = async (taskId: string) => ({
    id: taskId,
    name: 'Scan Media Library',
    state: 'Running',
  });
  try {
    // Arm a poll whose monitor started beyond the 30-min horizon.
    h.scheduleTaskPoll('task-1', Date.now() - 31 * 60 * 1000);
    await flush();
    assert.deepEqual(completed, [
      { taskId: 'task-1', taskName: 'Scan Media Library', status: 'TimedOut' },
    ]);
    assert.equal(pendingCount(), 0, 'monitoring must stop after the timeout');
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
