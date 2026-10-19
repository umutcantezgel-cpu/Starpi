// @ts-check
// The companion module `computer`: computer control, experimental and off by default. The command
// line adds it only when the configuration says `"experimental": { "computer": true }`; its own
// settings live under `modules.computer`. In this release it drives the mock actor only; the macOS
// actor is a preview, not verified on hardware, and the setting `actor: "macos"` is refused.
//
// Routes (below /v1/computer/):
//   GET  /                     member  state: consent, stop flag, the running mandate, the open approval
//                                      (its preview only for the mandate owner), hints and summaries
//   POST /consent              owner   { grant: true, version } grants, { grant: false } withdraws
//   POST /mandate              owner   { task, shareable?, actions? } starts a mandate
//   POST /mandate/extend       member  { mandate } extends it (the mandate owner only)
//   POST /stop                 member  stops at once; never refused
//   POST /approvals/:id        member  { decision: 'allow' | 'deny' } (the mandate owner only)
//   GET  /journal              owner   the steps and notes of this run of the companion
import { checkRecord, isRecord, oneOf, text } from '../contracts/check.js';
import { fail } from '../lib/errors.js';
import { assertActor } from './actor.js';
import { createMockActor } from './actor-mock.js';
import { MACOS_ACTOR_STATUS } from './actor-macos.js';
import { createAgentLoop } from './agent.js';
import { createController } from './control.js';
import {
  APPROVAL_FLOOR_S, APPROVAL_LIMIT_S, COMPUTER_MODULE_ID, COMPUTER_MODULE_VERSION, COMPUTER_NAMESPACE, HOLD_BEFORE_END_S,
  MANDATE_FLOOR_S, MANDATE_LIMIT_S, QUIET_AFTER_ACTION_MS, TURN_LIMIT,
} from './limits.js';
import { LIST_OPTIONS, buildPolicy, checkListOptions } from './lists.js';
import { openComputerState } from './state.js';

/** @param {number} min @param {number} max */
const wholeNumber = (min, max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? null : `a whole number from ${min} to ${max}`);

/** Members of `modules.computer`. */
const OPTION_RULES = Object.freeze({
  ...LIST_OPTIONS,
  actor: (/** @type {unknown} */ v) => (v === 'macos' ? `the macOS actor is a ${MACOS_ACTOR_STATUS.note}; this release runs "mock" only` : oneOf(['mock'])(v)),
  mandateSeconds: wholeNumber(MANDATE_FLOOR_S, MANDATE_LIMIT_S),
  approvalSeconds: wholeNumber(APPROVAL_FLOOR_S, APPROVAL_LIMIT_S),
  maxTurns: wholeNumber(1, TURN_LIMIT),
  brain: text(64),
});

/**
 * Every problem of the module configuration.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function checkComputerOptions(raw) {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['modules.computer: an object'];
  const problems = checkRecord(raw, 'modules.computer', OPTION_RULES);
  return problems.length > 0 ? problems : checkListOptions(raw);
}

/**
 * The controller settings from a checked module configuration.
 * @param {Record<string, unknown>} raw
 */
export function computerSettings(raw) {
  const mandateS = /** @type {number | undefined} */ (raw.mandateSeconds) ?? MANDATE_LIMIT_S;
  return {
    mandateS,
    approvalS: /** @type {number | undefined} */ (raw.approvalSeconds) ?? APPROVAL_LIMIT_S,
    holdS: Math.min(HOLD_BEFORE_END_S, mandateS - 10),
    quietMs: QUIET_AFTER_ACTION_MS,
    maxTurns: /** @type {number | undefined} */ (raw.maxTurns) ?? TURN_LIMIT,
    brain: typeof raw.brain === 'string' ? raw.brain : null,
  };
}

/**
 * The session behind a request of a signed-in route.
 * @param {{ session: import('../auth/sessions.js').Session | null }} req
 * @returns {import('./control.js').Who}
 */
function whoOf(req) {
  const s = req.session;
  if (!s) throw fail('unauthorized', 'sign in first', { status: 401 });
  return { session: s.id, role: s.role };
}

/**
 * Creates the module.
 * @param {object} [options]
 * @param {import('./actor.js').Actor} [options.actor]   the actor (default: a mock actor on the demo scene)
 * @param {readonly string[]} [options.ownOrigins]       origins the Starpi app is served from
 * @param {import('../lib/clock.js').Clock} [options.clock]  overrides the kernel's clock
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createComputerModule({ actor, ownOrigins = [], clock } = {}) {
  /** @type {import('./control.js').Controller | null} */
  let controller = null;
  const ready = () => {
    if (controller === null) throw fail('computer_not_ready', 'the computer control is not running', { status: 503 });
    return controller;
  };

  /**
   * The routes, served below /v1/computer/. Stop, consent and the state run in the breaker's status
   * lane, so neither a stop nor a withdrawal is ever held back.
   * @type {Array<import('../contracts/module.js').ModuleRoute & { lane?: 'status' | 'interactive' }>}
   */
  const routes = [
    { method: 'GET', path: '/', access: 'member', lane: 'status', handler: (req) => ({ body: ready().status(whoOf(req)) }) },
    {
      method: 'POST', path: '/consent', access: 'owner', lane: 'status',
      handler: async (req) => {
        const grant = req.body?.grant;
        if (grant === true) return { body: ready().grantConsent(whoOf(req), req.body) };
        if (grant === false) return { body: await ready().revokeConsent(whoOf(req)) };
        throw fail('consent_invalid', 'send { grant: true, version } or { grant: false }', { status: 400 });
      },
    },
    { method: 'POST', path: '/mandate', access: 'owner', handler: (req) => ({ body: ready().startMandate(whoOf(req), req.body) }) },
    { method: 'POST', path: '/mandate/extend', access: 'member', handler: (req) => ({ body: ready().extend(whoOf(req), req.body) }) },
    { method: 'POST', path: '/stop', access: 'member', lane: 'status', handler: async (req) => ({ body: await ready().stop(whoOf(req)) }) },
    { method: 'POST', path: '/approvals/:id', access: 'member', handler: (req) => ({ body: ready().decide(whoOf(req), req.params.id, req.body) }) },
    { method: 'GET', path: '/journal', access: 'owner', handler: () => ({ body: ready().journal() }) },
  ];

  return {
    id: COMPUTER_MODULE_ID,
    version: COMPUTER_MODULE_VERSION,
    title: 'Computer control (experimental)',
    namespaces: [COMPUTER_NAMESPACE],
    routes,
    /** @param {any} ctx  the kernel narrowed to this module */
    async start(ctx) {
      const raw = ctx.config ?? {};
      const problems = checkComputerOptions(raw);
      if (problems.length > 0) throw fail('computer_config', `modules.computer has problems: ${problems.join('; ')}`, { details: { problems } });
      const settings = computerSettings(raw);
      const chosen = assertActor(actor ?? createMockActor());
      const policy = buildPolicy(raw, { ownOrigins });
      const state = openComputerState(ctx.vault.namespace(COMPUTER_NAMESPACE));
      const made = createController({ actor: chosen, state, audit: ctx.audit, clock: clock ?? ctx.clock, policy, settings, log: ctx.log });
      const agent = createAgentLoop({ controller: made, brains: ctx.brains, policy, settings: { maxTurns: settings.maxTurns, brain: settings.brain } });
      made.useLoop(agent.drive);
      made.afterRestart();
      controller = made;
      ctx.log('warn', 'experimental_enabled', { actor: chosen.kind });
    },
    async stop() {
      const running = controller;
      controller = null;
      await running?.shutdown();
    },
  };
}

/**
 * The experimental modules a configuration turns on: the computer control when
 * `experimental.computer` is true, nothing otherwise.
 * @param {{ experimental?: { computer?: boolean }, allowedOrigins?: readonly string[] } | null | undefined} config
 * @param {{ actor?: import('./actor.js').Actor, clock?: import('../lib/clock.js').Clock }} [options]
 * @returns {import('../contracts/module.js').CompanionModule[]}
 */
export function experimentalModules(config, options = {}) {
  if (config?.experimental?.computer !== true) return [];
  return [createComputerModule({ ownOrigins: config.allowedOrigins ?? [], ...options })];
}
