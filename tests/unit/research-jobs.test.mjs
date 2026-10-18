// The research job engine (src/js/research/jobs.js) with stand-ins for the browser: a memory store
// shared like IndexedDB, a lock manager with the exclusive queue of Web Locks and a message bus
// that delivers like BroadcastChannel (to every other member, never to the sender). Covered: three
// jobs at most run at once, the queue moves on, cancel (running, queued, from another tab), one
// runner across tabs, jobs left running by a closed page come back stale and retry runs only what
// is missing, the heartbeat, and stale detection by heartbeat without Web Locks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createResearchJobs, MAX_RUNNING, RUNNER_LOCK, STALE_MS } from '../../src/js/research/jobs.js';

/** @typedef {import('../../src/js/research/jobs.js').ResearchJob} ResearchJob */

function memoryStore() {
  /** @type {Map<string, ResearchJob>} */
  const data = new Map();
  return {
    data,
    async all() {
      return [...data.values()].map((j) => structuredClone(j));
    },
    /** @param {ResearchJob} job */
    async put(job) {
      data.set(job.id, structuredClone(job));
    },
    /** @param {string} id */
    async remove(id) {
      data.delete(id);
    },
  };
}

/** Web Locks stand-in: one holder per name, the others wait in order. */
function fakeLocks() {
  /** @type {Map<string, Array<() => void>>} */
  const queues = new Map();
  const held = new Set();
  return {
    held,
    /**
     * @param {string} name
     * @param {{ mode: 'exclusive' }} _options
     * @param {() => Promise<void>} callback
     */
    request(name, _options, callback) {
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        const run = () => {
          held.add(name);
          callback().then(resolve, reject).finally(() => {
            held.delete(name);
            queue.shift();
            queue[0]?.();
          });
        };
        queue.push(run);
        if (queue.length === 1) run();
      });
    },
  };
}

/** BroadcastChannel stand-in: every other member receives a copy, asynchronously. */
function fakeBus() {
  /** @type {Set<{ deliver: (data: unknown) => void }>} */
  const members = new Set();
  return () => {
    /** @type {Array<(ev: { data: unknown }) => void>} */
    const listeners = [];
    const member = {
      deliver: (/** @type {unknown} */ data) => setTimeout(() => listeners.forEach((fn) => fn({ data: structuredClone(data) })), 0),
      /** @param {unknown} message */
      postMessage(message) {
        for (const other of members) if (other !== member) other.deliver(message);
      },
      /** @param {'message'} _type @param {(ev: { data: unknown }) => void} fn */
      addEventListener(_type, fn) {
        listeners.push(fn);
      },
      close() {
        members.delete(member);
      },
    };
    members.add(member);
    return member;
  };
}

/**
 * A pipeline stand-in: every job waits until the test finishes or fails it.
 */
function controlledRunner() {
  /** @type {Map<string, { finish: () => void, fail: (err: unknown) => void, signal: AbortSignal, job: ResearchJob, progress: Function }>} */
  const running = new Map();
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../../src/js/research/jobs.js').JobRunner} */
  const run = (job, { signal, progress }) =>
    new Promise((resolve, reject) => {
      calls.push(job.id);
      const outcome = () => ({
        plan: { queries: [job.question] },
        provider: { id: 'gemini', model: 'test-model' },
        parts: { sources: /** @type {any} */ ({ ...(job.parts.sources ?? {}), status: 'done', via: 'quote', excerpts: [] }), web: null },
        report: { artifactId: `research-${job.id}`, markdown: '# report' },
      });
      running.set(job.id, { finish: () => resolve(outcome()), fail: reject, signal, job, progress });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  return { run, running, calls };
}

/** Lets timers, the bus and pending writes run. */
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {() => boolean} predicate
 * @param {string} what
 */
async function until(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let seq = 0;
const ids = () => `job${String(++seq).padStart(4, '0')}`;

/**
 * @param {Partial<import('../../src/js/research/jobs.js').JobDeps>} over
 */
function engine(over) {
  const runner = controlledRunner();
  const jobs = createResearchJobs({ store: memoryStore(), run: runner.run, newId: ids, every: () => () => {}, ...over });
  return { jobs, runner };
}

/** @param {ReturnType<typeof createResearchJobs>} jobs */
const statuses = (jobs) => jobs.list().map((j) => j.status).sort();

describe('research jobs: queue', () => {
  it('runs three jobs at once and starts the next one when a job ends', async () => {
    const { jobs, runner } = engine({});
    await jobs.ready;
    const started = [];
    for (let i = 0; i < 5; i += 1) started.push(await jobs.start({ question: `Question ${i}?` }));
    await flush();
    assert.equal(MAX_RUNNING, 3);
    assert.equal(jobs.running(), 3);
    assert.deepEqual(statuses(jobs), ['queued', 'queued', 'running', 'running', 'running']);
    assert.deepEqual(runner.calls, started.slice(0, 3), 'oldest first');
    runner.running.get(started[0])?.finish();
    await until(() => runner.calls.length === 4, 'the fourth job');
    assert.equal(runner.calls[3], started[3]);
    const first = /** @type {ResearchJob} */ (jobs.get(started[0]));
    assert.equal(first.status, 'done');
    assert.equal(first.unread, true);
    assert.equal(first.artifactId, `research-${started[0]}`);
    assert.deepEqual(first.provider, { id: 'gemini', model: 'test-model' });
    assert.equal(jobs.running(), 3);
    assert.equal(jobs.active(), 4);
    jobs.dispose();
  });

  it('refuses an empty question and keeps the origin, scope and options of a job', async () => {
    const { jobs } = engine({ locale: () => 'de' });
    await assert.rejects(jobs.start({ question: '   ' }), TypeError);
    const id = await jobs.start({ question: '  Where   is it? ', origin: 'library', scope: { focus: 'plan.md' }, options: { web: true, stripPii: true } });
    const job = /** @type {ResearchJob} */ (jobs.get(id));
    assert.equal(job.question, 'Where is it?');
    assert.equal(job.origin, 'library');
    assert.equal(job.locale, 'de');
    assert.deepEqual(job.scope, { focus: 'plan.md', conversationId: null, nodeId: null });
    assert.deepEqual(job.options, { web: true, stripPii: true });
    const odd = await jobs.start({ question: 'x', origin: /** @type {any} */ ('elsewhere') });
    assert.equal(jobs.get(odd)?.origin, 'header');
    jobs.dispose();
  });

  it('records progress and finished parts while a job runs, and a failure with its code', async () => {
    const { jobs, runner } = engine({});
    const id = await jobs.start({ question: 'What changed?' });
    await until(() => runner.running.has(id), 'the job to run');
    const r = /** @type {any} */ (runner.running.get(id));
    r.progress({ step: 'sources', round: 2, sources: 4 }, { sources: { status: 'done', via: 'quote' } });
    assert.deepEqual(jobs.get(id)?.progress, { step: 'sources', round: 2, sources: 4 });
    assert.equal(jobs.get(id)?.parts.sources?.status, 'done');
    const warn = console.warn;
    console.warn = () => {};
    try {
      r.fail(Object.assign(new Error('nope'), { code: 'rate_limited' }));
      await until(() => jobs.get(id)?.status === 'failed', 'the failure');
    } finally {
      console.warn = warn;
    }
    assert.equal(jobs.get(id)?.error, 'rate_limited');
    assert.equal(jobs.get(id)?.progress, null);
    jobs.dispose();
  });

  it('keeps at most maxJobs jobs, dropping the oldest finished ones', async () => {
    const store = memoryStore();
    const { jobs, runner } = engine({ store, maxJobs: 3 });
    const a = await jobs.start({ question: 'a' });
    await until(() => runner.running.has(a), 'a');
    runner.running.get(a)?.finish();
    await until(() => jobs.get(a)?.status === 'done', 'a done');
    for (const q of ['b', 'c', 'd']) await jobs.start({ question: q });
    await jobs.settle();
    assert.equal(jobs.list().length, 3);
    assert.equal(jobs.get(a), null);
    assert.equal(store.data.has(a), false);
    jobs.dispose();
  });
});

describe('research jobs: cancel and remove', () => {
  it('cancels a running job (its signal aborts) and a queued one (it never runs)', async () => {
    const { jobs, runner } = engine({ maxRunning: 1 });
    const a = await jobs.start({ question: 'a' });
    const b = await jobs.start({ question: 'b' });
    await until(() => runner.running.has(a), 'a running');
    await jobs.cancel(b);
    assert.equal(jobs.get(b)?.status, 'cancelled');
    await jobs.cancel(a);
    assert.equal(runner.running.get(a)?.signal.aborted, true);
    await until(() => jobs.get(a)?.status === 'cancelled', 'a cancelled');
    await flush();
    assert.deepEqual(runner.calls, [a], 'the cancelled queued job never ran');
    jobs.dispose();
  });

  it('removes a job with its record and stops it when it runs', async () => {
    const store = memoryStore();
    const { jobs, runner } = engine({ store });
    const a = await jobs.start({ question: 'a' });
    await until(() => runner.running.has(a), 'a running');
    /** @type {string[]} */
    const changes = [];
    jobs.onChange((c) => changes.push(`${c.type}:${c.id}`));
    await jobs.remove(a);
    assert.equal(runner.running.get(a)?.signal.aborted, true);
    await flush();
    assert.equal(jobs.get(a), null);
    assert.equal(store.data.has(a), false, 'stays removed after the abort');
    assert.ok(changes.includes(`remove:${a}`));
    jobs.dispose();
  });
});

describe('research jobs: across tabs', () => {
  it('runs every job in one tab, wherever it was started, and cancels across tabs', async () => {
    const store = memoryStore();
    const locks = fakeLocks();
    const bus = fakeBus();
    const tabA = engine({ store, locks, channel: bus(), tabId: 'tab-a' });
    await until(() => tabA.jobs.isRunner(), 'tab A to hold the lock');
    const tabB = engine({ store, locks, channel: bus(), tabId: 'tab-b' });
    await tabB.jobs.ready;
    await flush();
    assert.equal(tabB.jobs.isRunner(), false);
    assert.ok(locks.held.has(RUNNER_LOCK));

    const id = await tabB.jobs.start({ question: 'Started in tab B' });
    await until(() => tabA.runner.running.has(id), 'tab A to run the job of tab B');
    assert.deepEqual(tabB.runner.calls, [], 'tab B runs nothing');
    await until(() => tabB.jobs.get(id)?.status === 'running', 'tab B to see it running');
    assert.equal(tabB.jobs.running(), 1);
    assert.equal(tabB.jobs.get(id)?.runner, 'tab-a');

    await tabB.jobs.cancel(id);
    await until(() => tabA.runner.running.get(id)?.signal.aborted === true, 'tab A to abort');
    await until(() => tabA.jobs.get(id)?.status === 'cancelled' && tabB.jobs.get(id)?.status === 'cancelled', 'both tabs to show the cancel');

    // Tab A closes: tab B takes the lock and runs what is queued.
    const next = await tabB.jobs.start({ question: 'After tab A closed' });
    tabA.jobs.dispose();
    await until(() => tabB.jobs.isRunner(), 'tab B to take over');
    await until(() => tabB.runner.running.has(next) || tabA.runner.running.has(next), 'someone to run the next job');
    tabB.jobs.dispose();
  });

  it('marks a job a closed page left running as stale; retry runs only the missing parts', async () => {
    const store = memoryStore();
    const locks = fakeLocks();
    const bus = fakeBus();
    const first = engine({ store, locks, channel: bus(), tabId: 'page-1' });
    await until(() => first.jobs.isRunner(), 'the first page to run jobs');
    const id = await first.jobs.start({ question: 'Long research', options: { web: true } });
    await until(() => first.runner.running.has(id), 'the job to run');
    const r = /** @type {any} */ (first.runner.running.get(id));
    r.progress({ step: 'web', round: 1, sources: 3 }, { sources: { status: 'done', via: 'quote', excerpts: [] }, web: { status: 'running', sources: [] } });
    await first.jobs.settle();
    // The page reloads: nothing more is written, the lock is released.
    first.jobs.dispose();
    await flush();
    assert.equal(store.data.get(id)?.status, 'running');

    const reloaded = engine({ store, locks, channel: bus(), tabId: 'page-2' });
    await until(() => reloaded.jobs.isRunner(), 'the reloaded page to run jobs');
    await until(() => reloaded.jobs.get(id)?.status === 'stale', 'the job to be stale');
    const stale = /** @type {ResearchJob} */ (reloaded.jobs.get(id));
    assert.equal(stale.parts.web?.status, 'cancelled');
    assert.equal(stale.parts.sources?.status, 'done');
    assert.equal(await reloaded.jobs.retry(id), true);
    await until(() => reloaded.runner.running.has(id), 'the retry to run');
    const rerun = /** @type {any} */ (reloaded.runner.running.get(id)).job;
    assert.equal(rerun.parts.sources.status, 'done', 'the finished part is kept');
    assert.equal(rerun.parts.web, null, 'the unfinished part runs again');
    reloaded.runner.running.get(id)?.finish();
    await until(() => reloaded.jobs.get(id)?.status === 'done', 'the retried job to finish');
    assert.equal(await reloaded.jobs.retry(id), false, 'a done job is not retried');
    reloaded.jobs.dispose();
  });

  it('stamps a heartbeat on running jobs, and without Web Locks treats a silent runner as gone', async () => {
    /** @type {Array<() => void>} */
    const beats = [];
    let clock = 1_000_000;
    const store = memoryStore();
    const { jobs, runner } = engine({ store, now: () => clock, every: (fn) => (beats.push(fn), () => {}) });
    const id = await jobs.start({ question: 'beat' });
    await until(() => runner.running.has(id), 'running');
    clock += 10_000;
    for (const beat of beats) beat();
    assert.equal(jobs.get(id)?.heartbeatAt, clock);
    jobs.dispose();

    // A record of another tab: fresh heartbeat stays running, an old one becomes stale.
    const other = memoryStore();
    const base = /** @type {ResearchJob} */ (structuredClone(store.data.get(id)));
    await other.put({ ...base, id: 'fresh', runner: 'tab-x', heartbeatAt: clock - 5_000 });
    await other.put({ ...base, id: 'silent', runner: 'tab-y', heartbeatAt: clock - STALE_MS - 1 });
    const solo = engine({ store: other, now: () => clock });
    await solo.jobs.ready;
    await solo.jobs.settle();
    assert.equal(solo.jobs.get('fresh')?.status, 'running');
    assert.equal(solo.jobs.get('silent')?.status, 'stale');
    solo.jobs.dispose();
  });
});
