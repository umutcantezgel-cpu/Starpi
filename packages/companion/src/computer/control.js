// @ts-check
// The controller of the computer control. It owns the consent, the one running mandate, the stop,
// the approvals and the execution of single steps; the agent loop (agent.js) only proposes steps.
//
//  - Consent: granted and withdrawn by the owner role. Withdrawing works at any time and ends the
//    running mandate at once.
//  - Mandate: started by the owner role with a task, for at most 120 seconds. It is never extended
//    on its own: the session that started it (the mandate owner) extends it actively, which sets
//    the deadline to the full length from now again. With little time left no step starts and the
//    loop waits for that extension or the end.
//  - Stop: any paired session, never refused, no model involved. It aborts the model request and
//    the step in progress, waits briefly for the standstill and records how long that took. Every
//    stop request is recorded with what it met (nothing running, a running mandate, or a mandate an
//    expiry, a withdrawal or the loop is already ending). The stop flag survives a restart; a restart
//    also ends a mandate that was running.
//  - Approvals: a step of the high class waits until the mandate owner decides; any other session is
//    refused. Nobody can approve while the actor works or right after its last step (the quiet
//    period), so the actor cannot approve its own step by pressing the button. An approved step is
//    looked at again just before it runs; a different target voids the approval.
//  - Every decision and every step is a record in the audit chain (ids, codes, counts, app ids; no
//    task text, typed text, window titles or screen content). Task, previews, the journal and model
//    text live in memory only and go with the mandate. Hints and model summaries are shown to owner
//    sessions and to the session that started their mandate; other members see the state only.
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../lib/canonical.js';
import { isoAt } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { decideClass, keyName } from './classes.js';
import {
  ACTION_NAMES, ACTIONS, CONSENT_STATEMENT, CONSENT_VERSION, JOURNAL_LIMIT, MANDATE_LIMIT_S, SETTLE_LIMIT_MS, START_CLASS,
  TASK_TEXT_MAX, TYPE_PIECE_CHARS,
} from './limits.js';
import { SECRET_ROLE } from './lists.js';

/**
 * The paired session behind a request.
 * @typedef {object} Who
 * @property {string} session
 * @property {'owner' | 'member'} role
 */

/**
 * @typedef {object} Settings
 * @property {number} mandateS    length of a mandate and of each extension
 * @property {number} approvalS   life of an approval request
 * @property {number} holdS       no step starts with this little time left
 * @property {number} quietMs     the quiet period after the actor's last step
 */

/**
 * @typedef {object} Pending  an open approval request
 * @property {string} id
 * @property {number} seq
 * @property {string} action
 * @property {string[]} reasons
 * @property {string} digest      binds the decision to the step and the target it was asked for
 * @property {number} expiresAt
 * @property {Record<string, unknown>} preview  what the mandate owner sees before deciding
 * @property {(answer: 'allow' | 'deny' | 'expired' | 'ended') => void} settle
 * @property {unknown} timer
 */

/**
 * The running mandate, in memory.
 * @typedef {object} Run
 * @property {string} id
 * @property {string} owner        session id of the mandate owner
 * @property {string} task
 * @property {boolean} shareable   the owner declared that the screen holds nothing confidential
 * @property {string[]} actions
 * @property {number} startedAt
 * @property {number} expiresAt
 * @property {number} extensions
 * @property {number} seq          steps handled so far
 * @property {number} turns        model turns so far
 * @property {boolean} screenRead  the screen was read in this mandate (its content is now in play)
 * @property {AbortController} abort
 * @property {unknown} timer
 * @property {boolean} closed
 * @property {import('./limits.js').EndReason | null} ending  why it is ending, once it is
 * @property {Promise<void> | null} ended  settles when the end is written
 * @property {Pending | null} pending
 * @property {((extended: boolean) => void) | null} onExtend
 * @property {unknown[] | null} history  the agent loop's turns (memory only)
 */

/**
 * What the actor did with one step; `typed` counts the characters it typed before it stopped.
 * @typedef {({ ok: true, screen?: import('./actor.js').ScreenReport } | { ok: false, code: string }) & { typed: number }} ActOutcome
 */

/**
 * A hint or a model summary kept for the person, with the session that started its mandate.
 * @typedef {{ owner: string, note: Record<string, unknown> }} Note
 */

/**
 * What one step gives back to the agent loop: the report for the model, how the turn goes on
 * ('go' on with the next step, 'skip' the rest of the turn, 'hold' for an extension, 'over'), and
 * whether the actor performed something.
 * @typedef {{ report: Record<string, unknown>, flow: 'go' | 'skip' | 'hold' | 'over', ran: boolean }} StepOutcome
 */

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => {
  const handle = setTimeout(resolve, ms);
  handle.unref?.();
});

/**
 * @param {object} deps
 * @param {import('./actor.js').Actor} deps.actor
 * @param {import('./state.js').ComputerState} deps.state
 * @param {{ append: (entry: { kind: string, subject?: string, actor?: string, details?: Record<string, unknown> }) => unknown }} deps.audit
 * @param {import('../lib/clock.js').Clock} deps.clock
 * @param {import('./lists.js').Policy} deps.policy
 * @param {Settings} deps.settings
 * @param {(level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void} [deps.log]
 */
export function createController({ actor, state, audit, clock, policy, settings, log = () => {} }) {
  /** @type {Run | null} */
  let current = null;
  /** The step the actor performs right now. @type {Promise<unknown> | null} */
  let acting = null;
  /** When the actor's last step ended. @type {number | null} */
  let lastStepEnd = null;
  /** @type {((run: Run) => Promise<void>) | null} */
  let loop = null;
  /** @type {Array<Record<string, unknown>>} */
  const journal = [];
  /** Hints (codes) and model summaries for the person, memory only. @type {Note[]} */
  const notes = [];

  const iso = () => isoAt(clock.now());
  /** @template T @param {T[]} list @param {T} entry */
  const keep = (list, entry) => {
    list.push(entry);
    if (list.length > JOURNAL_LIMIT) list.splice(0, list.length - JOURNAL_LIMIT);
  };
  /** @param {Who | null} who */
  const label = (who) => (who ? `session:${who.session.slice(0, 8)}` : 'companion');
  /** @param {string} kind @param {string} subject @param {Who | null} who @param {Record<string, unknown>} details */
  const record = (kind, subject, who, details) => audit.append({ kind: `computer.${kind}`, subject, actor: label(who), details });

  /** True while the actor works and during the quiet period after its last step. */
  const quiet = () => acting !== null || (lastStepEnd !== null && clock.now() - lastStepEnd < settings.quietMs);
  /** @param {Run} run */
  const remainingMs = (run) => run.expiresAt - clock.now();
  /** @param {Run} run */
  const holding = (run) => remainingMs(run) <= settings.holdS * 1000;
  /** Actions a mandate may name: opening apps only when the configuration lists some. */
  const offered = () => ACTION_NAMES.filter((a) => a !== ACTIONS.open || policy.openable.size > 0);

  /**
   * Records a refused request and throws it.
   * @param {string} route @param {Who} who @param {string} code @param {number} status @param {string} message
   * @returns {never}
   */
  function refuse(route, who, code, status, message) {
    try {
      record('request.refused', route, who, { route, code });
    } catch (err) {
      log('warn', 'refusal_not_recorded', { route, code, error: err });
    }
    throw fail(code, message, { status });
  }

  /** @param {Run} run @param {string} code */
  function hint(run, code) {
    keep(notes, { owner: run.owner, note: { at: iso(), mandate: run.id, kind: 'hint', code } });
  }

  /** @param {Run} run @returns {import('./state.js').MandateRecord} */
  const recordOf = (run) => ({
    id: run.id, owner: run.owner, state: run.closed ? 'ended' : 'active', startedAt: isoAt(run.startedAt), expiresAt: isoAt(run.expiresAt),
    extensions: run.extensions, actions: [...run.actions], shareable: run.shareable, taskDigest: sha256Hex(run.task), endReason: null, endedAt: null,
  });

  /** @param {Run} run */
  function armDeadline(run) {
    if (run.timer !== null) clock.clearTimeout(run.timer);
    run.timer = clock.setTimeout(() => {
      if (current === run && !run.closed) end(run, 'expired', null).catch((err) => log('warn', 'expiry_failed', { error: err }));
    }, Math.max(0, remainingMs(run)));
  }

  // ------------------------------------------------------------------------- consent

  /** @param {Who} who @param {unknown} body  { version } */
  function grantConsent(who, body) {
    const version = /** @type {any} */ (body)?.version;
    if (version !== CONSENT_VERSION) refuse('consent', who, 'consent_version', 400, `grant the current consent statement (version ${CONSENT_VERSION})`);
    if (quiet()) refuse('consent', who, 'actor_busy', 409, 'the actor is working; try again in a moment');
    const consent = { at: iso(), by: who.session, version, statement: sha256Hex(CONSENT_STATEMENT) };
    // The record comes first: no consent without its trail.
    record('consent.granted', who.session.slice(0, 8), who, { version, statement: consent.statement });
    state.setConsent(consent);
    return { consent: true, version, at: consent.at };
  }

  /** @param {Who} who */
  async function revokeConsent(who) {
    // Withdrawing always works and takes effect first; the trail follows.
    state.setConsent(null);
    if (current) await end(current, 'revoked', who);
    try {
      record('consent.revoked', who.session.slice(0, 8), who, {});
    } catch (err) {
      log('warn', 'revocation_not_recorded', { error: err });
    }
    return { consent: false };
  }

  // ------------------------------------------------------------------------- mandate

  /** @param {(run: Run) => Promise<void>} fn  the agent loop of a mandate */
  function useLoop(fn) {
    loop = fn;
  }

  /** @param {Who} who @param {unknown} body  { task, shareable?, actions? } */
  function startMandate(who, body) {
    if (quiet()) refuse('mandate', who, 'actor_busy', 409, 'the actor is working; try again in a moment');
    if (state.read().consent === null) refuse('mandate', who, 'consent_missing', 409, 'grant the consent first');
    if (current !== null) refuse('mandate', who, 'mandate_running', 409, 'a mandate is running; stop it or wait for its end');
    const b = /** @type {Record<string, unknown>} */ (body ?? {});
    const task = typeof b.task === 'string' ? b.task.trim() : '';
    const fine = typeof body === 'object' && body !== null && !Array.isArray(body)
      && Object.keys(b).every((k) => k === 'task' || k === 'shareable' || k === 'actions')
      && task !== '' && task.length <= TASK_TEXT_MAX && (b.shareable === undefined || typeof b.shareable === 'boolean');
    if (!fine) refuse('mandate', who, 'mandate_invalid', 400, `a mandate is { task (1 to ${TASK_TEXT_MAX} characters), shareable?, actions? }`);
    const allowed = offered();
    const actions = b.actions === undefined ? allowed : b.actions;
    if (!Array.isArray(actions) || actions.length === 0 || new Set(actions).size !== actions.length || !actions.every((a) => allowed.includes(a))) {
      refuse('mandate', who, 'mandate_invalid', 400, `actions is a list taken from ${allowed.join(', ')}`);
    }
    if (loop === null) throw fail('computer_not_ready', 'the computer control has no agent loop', { status: 503 });
    const now = clock.now();
    /** @type {Run} */
    const run = {
      id: randomUUID(), owner: who.session, task, shareable: b.shareable === true, actions: [.../** @type {string[]} */ (actions)],
      startedAt: now, expiresAt: now + Math.min(settings.mandateS, MANDATE_LIMIT_S) * 1000, extensions: 0, seq: 0, turns: 0,
      screenRead: false, abort: new AbortController(), timer: null, closed: false, ending: null, ended: null, pending: null, onExtend: null,
      history: null,
    };
    record('mandate.started', run.id, who, { mandate: run.id, actions: run.actions, shareable: run.shareable, expiresAt: isoAt(run.expiresAt) });
    state.setHalt(null);
    state.setMandate(recordOf(run));
    current = run;
    armDeadline(run);
    const fn = loop;
    Promise.resolve()
      .then(() => fn(run))
      .catch(async (err) => {
        log('warn', 'loop_failed', { error: err });
        await end(run, 'failed', null);
      })
      .catch((err) => log('error', 'loop_end_failed', { error: err }));
    return { mandate: run.id, expiresAt: isoAt(run.expiresAt), actions: [...run.actions], shareable: run.shareable };
  }

  /** @param {Who} who @param {unknown} body  { mandate } */
  function extend(who, body) {
    const run = current;
    const id = /** @type {any} */ (body)?.mandate;
    if (run === null || run.closed || id !== run.id) refuse('extend', who, 'mandate_not_running', 409, 'that mandate is not running');
    if (who.session !== run.owner) refuse('extend', who, 'not_mandate_owner', 403, 'only the session that started the mandate may extend it');
    if (quiet()) refuse('extend', who, 'actor_busy', 409, 'the actor is working; try again in a moment');
    run.expiresAt = clock.now() + Math.min(settings.mandateS, MANDATE_LIMIT_S) * 1000;
    run.extensions += 1;
    record('mandate.extended', run.id, who, { mandate: run.id, extensions: run.extensions, expiresAt: isoAt(run.expiresAt) });
    state.setMandate(recordOf(run));
    armDeadline(run);
    const waiting = run.onExtend;
    run.onExtend = null;
    waiting?.(true);
    return { mandate: run.id, expiresAt: isoAt(run.expiresAt), extensions: run.extensions };
  }

  /**
   * Ends a mandate: aborts the model request and the step in progress, settles an open approval,
   * waits briefly for the standstill, then writes the end with the time it took. The abort happens
   * before this returns; `run.ended` settles once the end is written.
   * @param {Run} run
   * @param {import('./limits.js').EndReason} reason
   * @param {Who | null} who   null for the companion itself
   * @param {number} [t0]      performance.now() when the end was asked for
   * @returns {Promise<number | null>} milliseconds until standstill, null when it had ended already
   */
  function end(run, reason, who, t0 = performance.now()) {
    if (run.closed) return Promise.resolve(null);
    run.closed = true;
    run.ending = reason;
    const writing = finishEnd(run, reason, who, t0);
    run.ended = writing.then(() => {}, () => {});
    return writing;
  }

  /** The body of `end` once the mandate is marked closed. @param {Run} run @param {import('./limits.js').EndReason} reason @param {Who | null} who @param {number} t0 */
  async function finishEnd(run, reason, who, t0) {
    run.abort.abort();
    if (run.timer !== null) clock.clearTimeout(run.timer);
    run.pending?.settle('ended');
    const waiting = run.onExtend;
    run.onExtend = null;
    waiting?.(false);
    const inFlight = acting;
    if (inFlight) await Promise.race([inFlight.catch(() => {}), pause(SETTLE_LIMIT_MS)]);
    const stopMs = Math.max(0, Math.round(performance.now() - t0));
    if (current === run) current = null;
    try {
      state.setMandate({ ...recordOf(run), endReason: reason, endedAt: iso() });
      record('mandate.ended', run.id, who, { mandate: run.id, reason, stopMs: Math.min(stopMs, 3_600_000), steps: run.seq, turns: run.turns });
    } finally {
      run.task = '';
      run.history = null;
    }
    return stopMs;
  }

  /**
   * Stop: any paired session, never refused. The request is recorded whatever it meets: nothing
   * running ('idle'), a running mandate it ends ('running'), or a mandate already being ended by an
   * expiry, a withdrawal or the loop ('ending', with that reason); then it waits for the standstill.
   * @param {Who} who
   */
  async function stop(who) {
    const t0 = performance.now();
    const run = current;
    const met = run === null ? 'idle' : run.closed ? 'ending' : 'running';
    state.setHalt({ at: iso(), by: who.session });
    try {
      /** @type {Record<string, unknown>} */
      const details = { mandate: run?.id ?? null, met };
      if (run !== null && met === 'ending') details.ending = run.ending;
      record('stop.requested', run?.id ?? 'idle', who, details);
    } catch (err) {
      log('warn', 'stop_not_recorded', { met, error: err });
    }
    let stopMs = 0;
    if (run !== null && met === 'running') stopMs = (await end(run, 'stopped', who, t0)) ?? 0;
    else if (run !== null && run.ended !== null) {
      await run.ended;
      stopMs = Math.max(0, Math.round(performance.now() - t0));
    }
    return { stopped: true, mandate: run?.id ?? null, stopMs };
  }

  /** At module start: a mandate recorded as active did not survive the restart. */
  function afterRestart() {
    const left = state.read().mandate;
    if (left?.state !== 'active') return;
    state.setMandate({ ...left, state: 'ended', endReason: 'restart', endedAt: iso() });
    record('mandate.ended', left.id, null, { mandate: left.id, reason: 'restart', stopMs: 0, steps: null, turns: null });
  }

  /** At module stop. */
  async function shutdown() {
    if (current) await end(current, 'shutdown', null);
  }

  /** @param {Run} run @returns {Promise<boolean>} true when extended, false when the mandate ended */
  function waitForExtension(run) {
    if (run.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      run.onExtend = resolve;
    });
  }

  // ------------------------------------------------------------------------- approvals

  /** @param {Who} who @param {string} id @param {unknown} body  { decision: 'allow' | 'deny' } */
  function decide(who, id, body) {
    const run = current;
    const pending = run?.pending ?? null;
    if (run === null || pending === null || pending.id !== id) refuse('approval', who, 'approval_not_found', 404, 'no open approval with that id');
    const decision = /** @type {any} */ (body)?.decision;
    if (decision !== 'allow' && decision !== 'deny') refuse('approval', who, 'decision_invalid', 400, 'decision is allow or deny');
    if (who.session !== run.owner) refuse('approval', who, 'not_mandate_owner', 403, 'only the session that started the mandate may decide');
    if (quiet()) refuse('approval', who, 'actor_busy', 409, 'no approval while the actor works or right after its last step');
    if (clock.now() >= pending.expiresAt) refuse('approval', who, 'approval_expired', 410, 'the approval request has expired');
    record('approval.decided', pending.id, who, { approval: pending.id, mandate: run.id, step: pending.seq, action: pending.action, decision });
    pending.settle(decision);
    return { approval: pending.id, decision };
  }

  /** @param {Run} run @param {string} action @param {Record<string, unknown>} args @param {import('./classes.js').Target} target */
  const digestOf = (run, action, args, target) => sha256Hex(canonicalJson({ mandate: run.id, action, args, target }));

  /**
   * Asks the mandate owner and waits for the answer, the expiry or the end of the mandate.
   * @param {Run} run @param {number} seq @param {import('./classes.js').Step} step @param {import('./classes.js').Ruling} ruling
   * @returns {Promise<{ answer: 'allow' | 'deny' | 'expired' | 'ended', digest: string }>}
   */
  function askOwner(run, seq, step, ruling) {
    const digest = digestOf(run, step.action, step.args, ruling.target);
    if (run.closed) return Promise.resolve({ answer: 'ended', digest });
    const id = randomUUID();
    const expiresAt = clock.now() + settings.approvalS * 1000;
    /** @type {Record<string, unknown>} */
    const preview = { action: step.action, reasons: [...ruling.reasons], app: ruling.target.app, title: ruling.target.title, role: ruling.target.role, label: ruling.target.label, purpose: step.why };
    if (step.action === ACTIONS.type) preview.text = step.args.text;
    if (step.action === ACTIONS.press) preview.key = keyName(step.args.key);
    if (step.action === ACTIONS.click || step.action === ACTIONS.scroll) preview.at = step.args.at;
    if (step.action === ACTIONS.open) preview.open = step.args.app;
    record('approval.asked', id, null, { approval: id, mandate: run.id, step: seq, action: step.action, reasons: ruling.reasons, expiresAt: isoAt(expiresAt) });
    hint(run, 'approval_needed');
    return new Promise((resolve) => {
      /** @type {Pending} */
      const pending = {
        id, seq, action: step.action, reasons: [...ruling.reasons], digest, expiresAt, preview, timer: null,
        settle(answer) {
          if (run.pending !== pending) return;
          run.pending = null;
          clock.clearTimeout(pending.timer);
          resolve({ answer, digest });
        },
      };
      pending.timer = clock.setTimeout(() => {
        if (run.pending !== pending) return;
        try {
          record('approval.lapsed', id, null, { approval: id, mandate: run.id, step: seq });
        } catch (err) {
          log('warn', 'lapse_not_recorded', { error: err });
        }
        pending.settle('expired');
      }, settings.approvalS * 1000);
      run.pending = pending;
    });
  }

  // ------------------------------------------------------------------------- steps

  /**
   * Records one step in the chain and the journal.
   * @param {Run} run @param {number} seq @param {string} action @param {string} cls @param {string} outcome
   * @param {string[]} reasons @param {string | null} app @param {Record<string, unknown>} [extra]
   */
  function logStep(run, seq, action, cls, outcome, reasons, app, extra = {}) {
    const known = ACTION_NAMES.includes(action);
    const details = { mandate: run.id, step: seq, action: known ? action : 'unknown', cls, outcome, reasons, app, ...extra };
    record('step', `${run.id}:${seq}`, null, details);
    keep(journal, { at: iso(), ...details });
  }

  /**
   * A step the loop does not hand over because an earlier one of the same turn stopped the turn.
   * @param {Run} run @param {import('./classes.js').Step} step @param {'skip' | 'hold' | 'over'} why
   */
  function skip(run, step, why) {
    const seq = ++run.seq;
    const detail = why === 'hold' ? 'extension_needed' : why === 'over' ? 'mandate_ended' : 'earlier_step';
    logStep(run, seq, step.action, START_CLASS[step.action] ?? 'forbidden', 'skipped', [detail], null);
    return { step: seq, do: step.action, status: 'skipped', detail };
  }

  /**
   * What the actor reports about the target of a step. A failing report counts as an unknown target.
   * @param {Run} run @param {import('./classes.js').Step} step
   * @returns {Promise<import('./classes.js').Seen>}
   */
  async function inspect(run, step) {
    if (step.action === ACTIONS.open || run.closed) return {};
    const at = step.action === ACTIONS.click || step.action === ACTIONS.scroll ? /** @type {[number, number]} */ (step.args.at) : null;
    try {
      return (await actor.inspect({ action: step.action, at, signal: run.abort.signal })) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Performs an allowed step with the actor: one abort signal per step tied to the mandate, keys
   * one at a time, text in pieces with stop, deadline and the target field checked before each.
   * @param {Run} run @param {import('./classes.js').Step} step @param {import('./classes.js').Target} target @param {import('./classes.js').Seen} seen
   * @returns {Promise<ActOutcome>}
   */
  async function act(run, step, target, seen) {
    const local = new AbortController();
    const relay = () => local.abort();
    run.abort.signal.addEventListener('abort', relay, { once: true });
    const signal = local.signal;
    const alive = () => !run.closed && !signal.aborted && clock.now() < run.expiresAt;
    /** @type {import('./actor.js').Expect} */
    const expect = { front: typeof seen.front?.app === 'string' ? seen.front.app : null, app: target.app, title: target.title };
    const args = step.args;
    /** Characters typed so far: a typing step that stops part-way records only these. */
    let typed = 0;
    const work = (async () => {
      switch (step.action) {
        case ACTIONS.look: {
          const r = await actor.look({ signal });
          if (r.ok) run.screenRead = true;
          return r;
        }
        case ACTIONS.click:
          return actor.click({ at: /** @type {[number, number]} */ (args.at), expect, signal });
        case ACTIONS.scroll:
          return actor.scroll({ at: /** @type {[number, number]} */ (args.at), direction: String(args.direction), lines: Number(args.lines), expect, signal });
        case ACTIONS.press: {
          const key = /** @type {string} */ (keyName(args.key));
          const times = Number(args.times ?? 1);
          for (let n = 0; n < times; n++) {
            if (!alive()) return { ok: false, code: 'aborted' };
            if (n > 0 && holding(run)) return { ok: false, code: 'extension_needed' };
            const r = await actor.press({ key, expect, signal });
            if (!r.ok) return r;
          }
          return { ok: true };
        }
        case ACTIONS.type: {
          const chars = [...String(args.text)];
          const fieldExpect = { ...expect, role: target.role, label: target.label };
          for (let from = 0; from < chars.length; from += TYPE_PIECE_CHARS) {
            if (!alive()) return { ok: false, code: 'aborted' };
            if (from > 0) {
              if (holding(run)) return { ok: false, code: 'extension_needed' };
              const now = await inspect(run, step);
              const same = now.front?.app === expect.front && now.window?.app === target.app && (now.window?.title ?? null) === target.title
                && (now.element?.role ?? null) === target.role && (now.element?.label ?? null) === target.label && target.role !== SECRET_ROLE;
              if (!same) return { ok: false, code: 'target_moved' };
              if (!alive()) return { ok: false, code: 'aborted' };
            }
            const piece = chars.slice(from, from + TYPE_PIECE_CHARS);
            const r = await actor.typePiece({ text: piece.join(''), expect: fieldExpect, signal });
            if (!r.ok) return r;
            typed += piece.length;
          }
          return { ok: true };
        }
        case ACTIONS.open:
          return actor.open({ app: String(args.app), signal });
        default:
          return { ok: false, code: 'unknown_action' };
      }
    })();
    acting = work;
    try {
      return { .../** @type {any} */ (await work), typed };
    } catch {
      return { ok: false, code: signal.aborted ? 'aborted' : 'actor_failed', typed };
    } finally {
      if (acting === work) acting = null;
      lastStepEnd = clock.now();
      run.abort.signal.removeEventListener('abort', relay);
    }
  }

  /**
   * Handles one proposed step from start to end.
   * @param {Run} run @param {import('./classes.js').Step} step
   * @returns {Promise<StepOutcome>}
   */
  async function perform(run, step) {
    const seq = ++run.seq;
    const action = step.action;
    const base = { step: seq, do: ACTION_NAMES.includes(action) ? action : 'unknown' };
    const startCls = START_CLASS[action] ?? 'forbidden';
    if (run.closed) {
      logStep(run, seq, action, startCls, 'skipped', ['mandate_ended'], null);
      return { report: { ...base, status: 'skipped', detail: 'mandate_ended' }, flow: 'over', ran: false };
    }
    if (holding(run)) {
      logStep(run, seq, action, startCls, 'held', ['extension_needed'], null);
      hint(run, 'extension_needed');
      return { report: { ...base, status: 'held', detail: 'extension_needed' }, flow: 'hold', ran: false };
    }
    if (!run.actions.includes(action)) {
      logStep(run, seq, action, 'forbidden', 'refused', [ACTION_NAMES.includes(action) ? 'action_not_in_mandate' : 'unknown_action'], null);
      return { report: { ...base, status: 'refused', detail: 'action_not_in_mandate' }, flow: 'skip', ran: false };
    }

    let seen = await inspect(run, step);
    let ruling = decideClass(step, seen, policy, { task: run.task, screenRead: run.screenRead });
    if (ruling.cls === 'forbidden') {
      logStep(run, seq, action, 'forbidden', 'refused', ruling.reasons, ruling.target.app);
      if (ruling.reasons.includes('field_secret') || ruling.reasons.includes('field_unknown')) hint(run, ruling.reasons[0]);
      return { report: { ...base, status: 'refused', detail: ruling.reasons[0] }, flow: 'skip', ran: false };
    }

    if (ruling.cls === 'high') {
      const { answer, digest } = await askOwner(run, seq, step, ruling);
      if (answer !== 'allow') {
        const detail = answer === 'deny' ? 'approval_denied' : answer === 'expired' ? 'approval_expired' : 'mandate_ended';
        logStep(run, seq, action, 'high', answer === 'ended' ? 'aborted' : 'refused', [...ruling.reasons, detail], ruling.target.app);
        return { report: { ...base, status: 'refused', detail }, flow: run.closed ? 'over' : 'skip', ran: false };
      }
      // Look again right before the step: the approval covers exactly the target it was asked for.
      seen = await inspect(run, step);
      const again = decideClass(step, seen, policy, { task: run.task, screenRead: run.screenRead });
      if (run.closed || again.cls === 'forbidden' || digestOf(run, action, step.args, again.target) !== digest) {
        const detail = run.closed ? 'mandate_ended' : 'target_changed';
        logStep(run, seq, action, 'high', run.closed ? 'aborted' : 'refused', [...again.reasons, detail], again.target.app);
        return { report: { ...base, status: 'refused', detail }, flow: run.closed ? 'over' : 'skip', ran: false };
      }
      ruling = { ...again, cls: 'high', reasons: [...new Set([...ruling.reasons, ...again.reasons])] };
      if (holding(run)) {
        logStep(run, seq, action, 'high', 'held', ['extension_needed'], ruling.target.app);
        hint(run, 'extension_needed');
        return { report: { ...base, status: 'held', detail: 'extension_needed' }, flow: 'hold', ran: false };
      }
    }

    const result = await act(run, step, ruling.target, seen);
    const typed = action === ACTIONS.type ? { typedChars: result.typed } : {};
    if (result.ok) {
      logStep(run, seq, action, ruling.cls, 'done', ruling.reasons, ruling.target.app, typed);
      /** @type {Record<string, unknown>} */
      const report = { ...base, status: 'done' };
      if ('screen' in result && result.screen) report.screen = result.screen;
      return { report, flow: run.closed ? 'over' : ruling.cls === 'high' ? 'skip' : 'go', ran: true };
    }
    const outcome = result.code === 'aborted' || result.code === 'extension_needed' ? 'aborted' : 'failed';
    logStep(run, seq, action, ruling.cls, outcome, [...ruling.reasons, result.code], ruling.target.app, typed);
    if (result.code === 'permission_missing') hint(run, 'permission_missing');
    if (run.closed) return { report: { ...base, status: 'failed', detail: 'mandate_ended' }, flow: 'over', ran: true };
    if (result.code === 'extension_needed') {
      hint(run, 'extension_needed');
      return { report: { ...base, status: 'held', detail: 'extension_needed' }, flow: 'hold', ran: true };
    }
    return { report: { ...base, status: 'failed', detail: result.code }, flow: 'skip', ran: true };
  }

  /**
   * Records a model turn (which model, where it ran, what came back; never the text).
   * @param {Run} run @param {Record<string, unknown>} details
   */
  function noteTurn(run, details) {
    record('turn', `${run.id}:${run.turns}`, null, { mandate: run.id, turn: run.turns, ...details });
  }

  /** @param {Run} run @param {string} text @param {string} brain */
  function keepSummary(run, text, brain) {
    keep(notes, { owner: run.owner, note: { at: iso(), mandate: run.id, kind: 'model', brain, text } });
  }

  // ------------------------------------------------------------------------- reading

  /**
   * The state for one session. Hints and model summaries can quote the screen, typed text or window
   * titles, so only owner sessions and the session that started their mandate read them.
   * @param {Who} who
   */
  function status(who) {
    const saved = state.read();
    const run = current;
    const mine = run !== null && run.owner === who.session;
    const readable = who.role === 'owner' ? notes : notes.filter((n) => n.owner === who.session);
    return {
      actor: { kind: actor.kind, preview: actor.preview },
      consent: { granted: saved.consent !== null, at: saved.consent?.at ?? null, version: saved.consent?.version ?? null, current: CONSENT_VERSION },
      stopped: saved.halt !== null,
      quiet: quiet(),
      offered: offered(),
      mandate: run === null ? null : {
        id: run.id, mine, startedAt: isoAt(run.startedAt), expiresAt: isoAt(run.expiresAt),
        remainingS: Math.max(0, Math.ceil(remainingMs(run) / 1000)), holding: holding(run), extensions: run.extensions,
        actions: [...run.actions], shareable: run.shareable, screenRead: run.screenRead, steps: run.seq, turns: run.turns,
      },
      approval: run?.pending ? {
        id: run.pending.id, action: run.pending.action, reasons: [...run.pending.reasons], expiresAt: isoAt(run.pending.expiresAt),
        ...(mine ? { preview: { ...run.pending.preview } } : {}),
      } : null,
      notes: readable.slice(-50).map((n) => ({ ...n.note })),
    };
  }

  return {
    grantConsent, revokeConsent, useLoop, startMandate, extend, stop, decide, end, afterRestart, shutdown, waitForExtension,
    perform, skip, hint, noteTurn, keepSummary, status, offered,
    journal: () => ({ steps: journal.map((e) => ({ ...e })), notes: notes.map((n) => ({ ...n.note })) }),
    /** @returns {Run | null} */
    current: () => current,
    quiet,
  };
}

/** @typedef {ReturnType<typeof createController>} Controller */
