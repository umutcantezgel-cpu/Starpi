import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { createBreaker } from '../src/breaker/breaker.js';
import { createAdmission } from '../src/admission/admission.js';
import { manualClock } from '../src/lib/clock.js';
import { createNotifier } from '../src/platform/sd-notify.js';

/** A promise and its resolver. */
function gate() {
  /** @type {(v?: unknown) => void} */
  let open = () => {};
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('scheduler: the interactive lane keeps its reserved slot and goes first; background yields', async () => {
  const s = createScheduler({ concurrency: 2, interactiveReserve: 1 });
  const hold = gate();
  /** @type {string[]} */
  const order = [];
  const events = s.run('events', 'e1', async () => {
    order.push('e1');
    await hold.promise;
  });
  const queued = s.run('events', 'e2', async () => order.push('e2'));
  let yielded = null;
  const bg = s.run('background', 'b1', async (ctx) => {
    yielded = ctx.shouldYield();
    order.push('b1');
  });
  const inter = s.run('interactive', 'i1', async () => order.push('i1'));
  await inter;
  assert.deepEqual(order, ['e1', 'i1'], 'events use only the shared slot, interactive takes the reserve');
  hold.open();
  await Promise.all([events, queued, bg]);
  assert.deepEqual(order, ['e1', 'i1', 'e2', 'b1']);
  assert.equal(yielded, false);
  assert.equal(s.stats().done, 4);
  s.pause(['background']);
  let ran = false;
  const paused = s.run('background', 'b2', async () => {
    ran = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ran, false);
  s.resume(['background']);
  await paused;
  assert.equal(ran, true);
  s.stop();
  await assert.rejects(s.run('interactive', 'late', async () => 1), (err) => /** @type {any} */ (err).code === 'scheduler_stopped');
});

test('scheduler: periodic jobs follow the clock and never overlap', async () => {
  const clock = manualClock();
  const s = createScheduler({ clock });
  let runs = 0;
  const cancel = s.every('tick', 1000, () => {
    runs += 1;
  });
  clock.advance(999);
  assert.equal(runs, 0);
  clock.advance(1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 1);
  clock.advance(1000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2);
  cancel();
  clock.advance(5000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2);
  s.stop();
});

test('breaker: rises with errors and memory, only the owner steps it down', () => {
  const clock = manualClock();
  /** @type {any[]} */
  const changes = [];
  const b = createBreaker({ clock, minEvents: 10, onChange: (c) => changes.push(c) });
  for (let i = 0; i < 7; i += 1) b.record(true);
  for (let i = 0; i < 3; i += 1) b.record(false);
  assert.equal(b.level(), 'slowed');
  assert.equal(b.allows('background'), false);
  assert.equal(b.allows('events'), true);
  for (let i = 0; i < 4; i += 1) b.record(false);
  assert.equal(b.level(), 'paused');
  assert.equal(b.allows('events'), false);
  for (let i = 0; i < 21; i += 1) b.record(false);
  assert.equal(b.level(), 'isolated');
  assert.equal(b.allows('interactive'), true);
  assert.equal(b.allows('interactive', { cloud: true }), false);
  clock.advance(120_000);
  for (let i = 0; i < 20; i += 1) b.record(true);
  assert.equal(b.level(), 'isolated', 'never steps down by itself');
  b.observe({ rssMb: 4000 });
  assert.equal(b.level(), 'halted');
  assert.equal(b.allows('interactive'), false);
  assert.equal(b.allows('status'), true);
  assert.throws(() => b.reset({ actor: 'owner', reason: '' }), /names who resets and why/);
  b.observe({ rssMb: 100 });
  b.reset({ actor: 'owner', reason: 'restarted the model server' });
  assert.equal(b.level(), 'steady');
  assert.deepEqual(changes.map((c) => c.to), ['slowed', 'paused', 'isolated', 'halted', 'steady']);
  assert.equal(changes.at(-1).actor, 'owner');
});

test('admission: shares a loaded model, waits by lane, keeps a reserve from background work, times out', async () => {
  const clock = manualClock();
  const a = createAdmission({ budgetMb: 1000, reserveMb: 300, clock, timeoutMs: 5000 });
  const big = await a.acquire({ model: 'big', sizeMb: 600 });
  const shared = await a.acquire({ model: 'big', sizeMb: 600 });
  assert.equal(a.stats().usedMb, 600);
  /** @type {string[]} */
  const granted = [];
  const bg = a.acquire({ model: 'small-bg', sizeMb: 200, lane: 'background' }).then((l) => {
    granted.push('background');
    return l;
  });
  const inter = a.acquire({ model: 'small-int', sizeMb: 300, lane: 'interactive' }).then((l) => {
    granted.push('interactive');
    return l;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(granted, ['interactive'], 'background must leave the reserve free');
  big.release();
  shared.release();
  shared.release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(granted, ['interactive', 'background']);
  (await inter).release();
  (await bg).release();
  await assert.rejects(a.acquire({ model: 'huge', sizeMb: 5000 }), (err) => /** @type {any} */ (err).code === 'admission_too_large');
  const hog = await a.acquire({ model: 'hog', sizeMb: 900 });
  const waiting = a.acquire({ model: 'other', sizeMb: 500 });
  clock.advance(5000);
  await assert.rejects(waiting, (err) => /** @type {any} */ (err).code === 'admission_timeout');
  hog.release();
  assert.equal(a.stats().waiting, 0);
});

test('sd-notify: READY and watchdog through systemd-notify only under systemd; the variables leave the environment', async () => {
  /** @type {Array<{ args: readonly string[], env: any }>} */
  const calls = [];
  const run = async (/** @type {string} */ _file, /** @type {readonly string[]} */ args, /** @type {any} */ options) => {
    calls.push({ args, env: options.env });
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  const clock = manualClock();
  const env = { NOTIFY_SOCKET: '/run/user/1000/systemd/notify', WATCHDOG_USEC: '30000000', HOME: '/x' };
  const notifier = createNotifier({ env, run, clock, exists: () => true });
  assert.equal(env.NOTIFY_SOCKET, undefined);
  assert.equal(env.WATCHDOG_USEC, undefined);
  assert.equal(await notifier.ready('listening'), true);
  assert.deepEqual(calls[0], { args: ['--ready', '--status=listening'], env: { NOTIFY_SOCKET: '/run/user/1000/systemd/notify' } });
  clock.advance(10_000);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls[1].args, ['WATCHDOG=1']);
  await notifier.stopping();
  assert.deepEqual(calls.at(-1)?.args, ['STOPPING=1']);
  const quiet = createNotifier({ env: {}, run });
  const before = calls.length;
  assert.equal(await quiet.ready('x'), false);
  assert.equal(calls.length, before);
});
