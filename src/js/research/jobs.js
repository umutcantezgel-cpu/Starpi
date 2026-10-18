// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Research jobs: a queue that runs in the background of the page and survives a reload. start()
// stores a job and returns its id at once; the job reports through onChange(), can be cancelled,
// and its report stays in the database (store `research`, the report itself in `artifacts`).
//
// Rules:
//   - At most MAX_RUNNING jobs run at a time; the others wait as 'queued', oldest first.
//   - One tab runs them all. Every tab of the app asks for the Web Lock RUNNER_LOCK; the tab that
//     holds it is the runner, the others wait for it. A tab that starts or cancels a job writes the
//     record and says so on the BroadcastChannel CHANNEL_NAME; the runner picks the job up, and every
//     tab reads the new state from the store. When the runner tab closes or reloads, its lock goes to
//     the next tab.
//   - The runner stamps the jobs it runs with a heartbeat every HEARTBEAT_MS. A tab that becomes the
//     runner owns the lock alone, so a job still marked 'running' then has nobody running it: it
//     becomes 'stale' and offers a retry, which runs only the parts that are not done yet. Without
//     Web Locks (old browsers), every tab is its own runner, and a running job of another tab counts
//     as stale once its heartbeat is older than STALE_MS.
//   - A cancel aborts the job where it runs; parts that finished before stay with the record.
// The world (store, lock manager, channel, clock, timers, the pipeline itself) comes in through
// JobDeps, so tests run several engines side by side as stand-ins for tabs.

/** @typedef {import('./deep.js').ResearchProgress} ResearchProgress */
/** @typedef {import('./deep.js').ResearchOutcome} ResearchOutcome */
/** @typedef {import('./deep.js').SourcesPart} SourcesPart */
/** @typedef {import('./web-part.js').WebPart} WebPart */

/** @typedef {'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'stale'} JobStatus */
/** @typedef {'chat' | 'library' | 'header'} JobOrigin */

/**
 * A research job as the store keeps it.
 * @typedef {object} ResearchJob
 * @property {string} id
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} question
 * @property {JobOrigin} origin
 * @property {JobStatus} status
 * @property {number | null} heartbeatAt  the runner's last sign of life while it runs the job
 * @property {string | null} runner       the tab that runs (ran) it
 * @property {{ id: string, model: string }} provider  empty until a model served
 * @property {string} locale
 * @property {{ focus?: string | null, conversationId?: string | null, nodeId?: string | null }} scope
 * @property {{ web: boolean, stripPii: boolean }} options
 * @property {ResearchProgress | null} progress
 * @property {{ queries: string[] } | null} plan
 * @property {{ sources?: SourcesPart | null, web?: WebPart | null }} parts
 * @property {string | null} artifactId
 * @property {string | null} error
 * @property {boolean} unread             finished and not opened yet
 * @property {string} [receiptId]
 */

/**
 * @typedef {object} StartRequest
 * @property {string} question
 * @property {JobOrigin} [origin]          default 'header' (the Research tab)
 * @property {ResearchJob['scope']} [scope]
 * @property {Partial<ResearchJob['options']>} [options]
 * @property {string} [locale]
 */

/**
 * @typedef {object} JobStore
 * @property {() => Promise<ResearchJob[]>} all
 * @property {(job: ResearchJob) => Promise<void>} put
 * @property {(id: string) => Promise<void>} remove
 */

/**
 * The part of the Web Locks API the engine uses (navigator.locks).
 * @typedef {{ request: (name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>) => Promise<unknown> }} LockManagerLike
 */

/**
 * The part of a BroadcastChannel the engine uses.
 * @typedef {{ postMessage: (message: unknown) => void, addEventListener: (type: 'message', fn: (ev: { data: unknown }) => void) => void, close: () => void }} ChannelLike
 */

/**
 * @typedef {(job: ResearchJob, ctx: { signal: AbortSignal, progress: (p: ResearchProgress, parts?: { sources?: SourcesPart, web?: WebPart | null }) => void }) => Promise<ResearchOutcome>} JobRunner
 */

/**
 * @typedef {object} JobDeps
 * @property {JobStore} store
 * @property {JobRunner} run
 * @property {LockManagerLike | null} [locks]
 * @property {ChannelLike | null} [channel]
 * @property {string} [tabId]
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => () => void} [every]
 * @property {() => string} [newId]
 * @property {number} [maxRunning]
 * @property {number} [heartbeatMs]
 * @property {number} [staleMs]
 * @property {number} [maxJobs]
 * @property {() => string} [locale]
 */

/** @typedef {{ type: 'start' | 'progress' | 'finish' | 'cancel' | 'remove' | 'read' | 'sync' | 'runner', id?: string }} JobChange */

export const MAX_RUNNING = 3;
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
export const RUNNER_LOCK = 'starpi-research-runner';
export const CHANNEL_NAME = 'starpi-research';
/** Jobs kept; beyond that the oldest finished ones go first. */
export const MAX_JOBS = 50;
export const QUESTION_LIMIT = 2000;

const ORIGINS = new Set(['chat', 'library', 'header']);
const ACTIVE = new Set(['queued', 'running']);
const RETRYABLE = new Set(['stale', 'failed', 'cancelled']);

/** @param {unknown} err */
const isAbort = (err) => err instanceof DOMException && err.name === 'AbortError';

/** @param {unknown} err */
function errorCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  return typeof code === 'string' && /^[a-z_]{2,40}$/.test(code) ? code : 'error';
}

/**
 * Marks the parts of a job that were still running as cancelled.
 * @param {ResearchJob} job
 */
function stopParts(job) {
  const { sources, web } = job.parts;
  if (sources?.status === 'running') job.parts = { ...job.parts, sources: { ...sources, status: 'cancelled' } };
  if (web?.status === 'running') job.parts = { ...job.parts, web: { ...web, status: 'cancelled' } };
}

/** A random id (base36), unique enough for jobs and tabs of one browser. */
function randomId() {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('');
}

/**
 * Creates the job engine of one tab.
 * @param {JobDeps} deps
 */
export function createResearchJobs(deps) {
  const now = deps.now ?? (() => Date.now());
  const every =
    deps.every ??
    ((fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const newId = deps.newId ?? randomId;
  const tabId = deps.tabId ?? randomId();
  const maxRunning = deps.maxRunning ?? MAX_RUNNING;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = deps.staleMs ?? STALE_MS;
  const maxJobs = deps.maxJobs ?? MAX_JOBS;
  const locks = deps.locks ?? null;
  const channel = deps.channel ?? null;

  /** @type {Map<string, ResearchJob>} */
  const jobs = new Map();
  /** Jobs this tab runs. @type {Map<string, AbortController>} */
  const controllers = new Map();
  /** @type {Set<(change: JobChange) => void>} */
  const listeners = new Set();
  let runner = false;
  let disposed = false;
  /** @type {(() => void) | null} */
  let releaseLock = null;
  /** @type {(() => void) | null} */
  let stopBeat = null;
  /** Writes in order, one at a time. @type {Promise<unknown>} */
  let writes = Promise.resolve();

  /** @param {JobChange} change */
  function emit(change) {
    for (const fn of listeners) {
      try {
        fn(change);
      } catch (err) {
        console.error('[starpi] research listener failed', err);
      }
    }
  }

  /** @param {{ type: string, id?: string }} message */
  function tell(message) {
    try {
      channel?.postMessage({ ...message, from: tabId });
    } catch {
      // Another tab learns on its next read.
    }
  }

  /**
   * Stores a job (in order with every other write) and tells the other tabs.
   * @param {ResearchJob} job
   * @param {JobChange['type']} type
   */
  function save(job, type) {
    job.updatedAt = Math.max(now(), job.updatedAt);
    jobs.set(job.id, job);
    const copy = structuredClone(job);
    const done = (writes = writes.then(
      () => deps.store.put(copy),
      () => deps.store.put(copy),
    ));
    void done.then(
      () => tell({ type: 'changed', id: job.id }),
      (err) => console.warn('[starpi] research job not stored', err),
    );
    emit({ type, id: job.id });
    return done;
  }

  /** Reads every job from the store into the cache. */
  async function reload() {
    await writes.catch(() => {});
    const all = await deps.store.all();
    jobs.clear();
    for (const job of all) if (job && typeof job.id === 'string') jobs.set(job.id, job);
  }

  /**
   * A job of another runner whose heartbeat stopped (only without Web Locks; with them, taking the
   * lock decides).
   * @param {ResearchJob} job
   */
  const silent = (job) => job.status === 'running' && !controllers.has(job.id) && (job.heartbeatAt === null || now() - job.heartbeatAt > staleMs);

  /** @param {ResearchJob} job */
  function markStale(job) {
    job.status = 'stale';
    job.progress = null;
    stopParts(job);
    return save(job, 'progress');
  }

  /** Called when this tab becomes the runner. */
  async function takeOver() {
    await reload();
    for (const job of jobs.values()) {
      // With the lock held here, nobody else runs anything.
      if (job.status === 'running' && !controllers.has(job.id) && (locks || silent(job))) await markStale(job);
    }
    stopBeat?.();
    stopBeat = every(beat, heartbeatMs);
    emit({ type: 'runner' });
    pump();
  }

  function beat() {
    if (!locks) {
      for (const job of jobs.values()) if (silent(job)) void markStale(job);
    }
    for (const id of controllers.keys()) {
      const job = jobs.get(id);
      if (job && job.status === 'running') {
        job.heartbeatAt = now();
        void save(job, 'progress');
      }
    }
  }

  /** Starts queued jobs while fewer than maxRunning run here. */
  function pump() {
    if (!runner || disposed) return;
    const queued = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const job of queued) {
      if (controllers.size >= maxRunning) break;
      launch(job);
    }
  }

  /** @param {ResearchJob} job */
  function launch(job) {
    const ctrl = new AbortController();
    controllers.set(job.id, ctrl);
    job.status = 'running';
    job.runner = tabId;
    job.heartbeatAt = now();
    job.error = null;
    job.progress = { step: 'plan', round: 0, sources: 0 };
    void save(job, 'start');
    const progress = (/** @type {ResearchProgress} */ p, /** @type {{ sources?: SourcesPart, web?: WebPart | null } | undefined} */ parts) => {
      if (disposed || ctrl.signal.aborted || jobs.get(job.id) !== job) return;
      job.progress = p;
      if (parts?.sources) job.parts = { ...job.parts, sources: parts.sources };
      if (parts && 'web' in parts) job.parts = { ...job.parts, web: parts.web ?? null };
      void save(job, 'progress');
    };
    // A cancel ends the job at once, even while a step still waits for an answer: whatever that
    // step brings later is dropped.
    const stopped = new Promise((_, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    });
    Promise.race([Promise.resolve().then(() => deps.run(structuredClone(job), { signal: ctrl.signal, progress })), stopped])
      .then((outcome) => {
        if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new DOMException('Aborted', 'AbortError');
        job.status = 'done';
        job.plan = outcome.plan;
        if (outcome.provider) job.provider = outcome.provider;
        job.parts = { sources: outcome.parts.sources, web: outcome.parts.web };
        job.artifactId = outcome.report.artifactId;
        job.unread = true;
      })
      .catch((err) => {
        // The page is going away: the record stays 'running', and the next runner finds it stale.
        if (disposed) return;
        if (ctrl.signal.aborted || isAbort(err)) {
          job.status = 'cancelled';
          stopParts(job);
        } else {
          job.status = 'failed';
          job.error = errorCode(err);
          console.warn('[starpi] research job failed', err);
        }
      })
      .finally(() => {
        controllers.delete(job.id);
        if (disposed) return;
        job.progress = null;
        job.heartbeatAt = now();
        // A job removed meanwhile stays removed.
        if (jobs.get(job.id) === job) void save(job, 'finish');
        pump();
      });
  }

  /**
   * Keeps at most maxJobs records: the oldest finished ones go first.
   * @returns {Promise<void>}
   */
  async function trim() {
    const finished = [...jobs.values()].filter((j) => !ACTIVE.has(j.status)).sort((a, b) => a.updatedAt - b.updatedAt);
    let excess = jobs.size - maxJobs;
    for (const job of finished) {
      if (excess <= 0) break;
      excess -= 1;
      await remove(job.id);
    }
  }

  /**
   * @param {StartRequest} request
   * @returns {Promise<string>} the id of the new job
   */
  async function start(request) {
    const question = String(request?.question ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, QUESTION_LIMIT);
    if (!question) throw new TypeError('A research job needs a question');
    await ready;
    const at = now();
    /** @type {ResearchJob} */
    const job = {
      id: newId(),
      createdAt: at,
      updatedAt: at,
      question,
      origin: ORIGINS.has(/** @type {string} */ (request.origin)) ? /** @type {JobOrigin} */ (request.origin) : 'header',
      status: 'queued',
      heartbeatAt: null,
      runner: null,
      provider: { id: '', model: '' },
      locale: request.locale ?? deps.locale?.() ?? 'en',
      scope: { focus: request.scope?.focus ?? null, conversationId: request.scope?.conversationId ?? null, nodeId: request.scope?.nodeId ?? null },
      options: { web: request.options?.web === true, stripPii: request.options?.stripPii === true },
      progress: null,
      plan: null,
      parts: {},
      artifactId: null,
      error: null,
      unread: false,
    };
    await save(job, 'start');
    pump();
    await trim();
    return job.id;
  }

  /** @param {string} id */
  async function cancel(id) {
    const ctrl = controllers.get(id);
    if (ctrl) {
      ctrl.abort(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const job = jobs.get(id);
    if (!job || !ACTIVE.has(job.status)) return;
    job.status = 'cancelled';
    job.progress = null;
    await save(job, 'cancel');
    tell({ type: 'cancel', id });
  }

  /**
   * Queues a stale, failed or cancelled job again; parts that are done stay.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function retry(id) {
    const job = jobs.get(id);
    if (!job || !RETRYABLE.has(job.status)) return false;
    job.status = 'queued';
    job.error = null;
    job.progress = null;
    job.runner = null;
    job.heartbeatAt = null;
    const { sources, web } = job.parts;
    job.parts = { sources: sources?.status === 'done' ? sources : null, web: web && (web.status === 'done' || web.status === 'withheld') ? web : null };
    await save(job, 'start');
    pump();
    return true;
  }

  /** @param {string} id */
  async function remove(id) {
    controllers.get(id)?.abort(new DOMException('Removed', 'AbortError'));
    if (!jobs.delete(id)) return;
    const done = (writes = writes.then(
      () => deps.store.remove(id),
      () => deps.store.remove(id),
    ));
    await done.catch((err) => console.warn('[starpi] research job not removed', err));
    tell({ type: 'removed', id });
    emit({ type: 'remove', id });
  }

  /** @param {string} id */
  async function markRead(id) {
    const job = jobs.get(id);
    if (!job || !job.unread) return;
    job.unread = false;
    await save(job, 'read');
  }

  /**
   * A message of another tab.
   * @param {unknown} data
   */
  async function onMessage(data) {
    const m = /** @type {{ type?: unknown, id?: unknown, from?: unknown }} */ (data ?? {});
    if (disposed || m.from === tabId || typeof m.id !== 'string') return;
    const id = m.id;
    if (m.type === 'removed') {
      controllers.get(id)?.abort(new DOMException('Removed', 'AbortError'));
      if (jobs.delete(id)) emit({ type: 'remove', id });
      return;
    }
    if (m.type !== 'changed' && m.type !== 'cancel') return;
    await writes.catch(() => {});
    const fresh = (await deps.store.all()).find((j) => j?.id === id);
    if (!fresh) return;
    const running = controllers.get(id);
    if (running) {
      // This tab runs the job: only a cancel from elsewhere counts, its own state stays.
      if (fresh.status === 'cancelled' || m.type === 'cancel') running.abort(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    jobs.set(id, fresh);
    emit({ type: 'sync', id });
    if (fresh.status === 'queued') pump();
  }

  const ready = (async () => {
    try {
      await reload();
    } catch (err) {
      console.warn('[starpi] research jobs could not be read', err);
    }
    channel?.addEventListener('message', (ev) => void onMessage(ev.data));
    if (!locks) {
      runner = true;
      await takeOver();
      return;
    }
    // Waits in the background until this tab holds the lock; resolves `ready` at once.
    void locks
      .request(RUNNER_LOCK, { mode: 'exclusive' }, async () => {
        if (disposed) return;
        runner = true;
        await takeOver();
        await new Promise((resolve) => {
          releaseLock = () => resolve(undefined);
        });
      })
      .catch((err) => console.warn('[starpi] research runner lock failed', err));
  })();

  return {
    ready,
    tabId,
    start,
    cancel,
    retry,
    remove,
    markRead,
    /** @returns {ResearchJob[]} newest first */
    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    /** @param {string} id */
    get: (id) => jobs.get(id) ?? null,
    /** Jobs running anywhere (in this tab or the runner tab). */
    running: () => [...jobs.values()].filter((j) => j.status === 'running').length,
    /** Jobs waiting or running. */
    active: () => [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length,
    isRunner: () => runner,
    /** @param {(change: JobChange) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Waits for every pending write (tests and shutdown). */
    settle: () => writes.catch(() => {}),
    /**
     * Stops this tab's engine as a closing page does: its running jobs stop without a further
     * write (the next runner finds them stale), the lock goes to the next tab, the heartbeat ends.
     */
    dispose() {
      disposed = true;
      runner = false;
      stopBeat?.();
      for (const ctrl of controllers.values()) ctrl.abort(new DOMException('Page closed', 'AbortError'));
      releaseLock?.();
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** @typedef {ReturnType<typeof createResearchJobs>} ResearchJobs */

/**
 * The store of jobs in the app database: store `research`, and on removal the job's report in
 * `artifacts` with it.
 * @param {() => Promise<import('../store/idb.js').StoreDb>} getDb
 * @returns {JobStore}
 */
export function idbJobStore(getDb) {
  return {
    async all() {
      const db = await getDb();
      return /** @type {ResearchJob[]} */ (await db.getAll('research'));
    },
    async put(job) {
      const db = await getDb();
      await db.put('research', job);
    },
    async remove(id) {
      const db = await getDb();
      await db.transaction(['research', 'artifacts'], 'readwrite', async (tx) => {
        await tx.delete('research', id);
        await tx.delete('artifacts', `research-${id}`);
      });
    },
  };
}
