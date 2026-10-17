// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Council: up to three models draft the same answer in parallel, each pinned (no fallback), and a
// judge decides between the valid drafts or merges them.
// - Members come from different providers where the pool allows it; the purpose's role goes first.
// - The judge is the strongest available model that is not a member (judge and reasoning roles and
//   reasoning capabilities count most); it is held back from the members while enough others remain.
// - The judge answers with the council_judge purpose: { chosen, reasons[], merged? }.
// - With fewer than two valid drafts no judge is asked: the best valid draft stands. A judge that
//   fails or is missing also leaves the best draft standing, and the result says why.
// - onUpdate receives a fresh snapshot after every change, so a panel fills while the calls run.
// Two modes: a purpose (each draft is validated like any purpose answer) or free chat (the
// conversation's messages; a draft is valid when it is a complete, non-empty answer).
import { messageText, textPart, withoutForeignOpaque } from './contract.js';
import { getPinnedModel } from './model-selection.js';
import { getPurpose } from './purposes.js';
import { routerDeps, runPurpose } from './router.js';
import { rolePool } from './roles.js';
import { applyThinking, isThinkingOn, thinkingFor } from './thinking.js';

/** @typedef {import('./contract.js').AiRequest} AiRequest */
/** @typedef {import('./contract.js').Caps} Caps */
/** @typedef {import('./contract.js').Message} Message */
/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('./purposes.js').PromptLocale} PromptLocale */
/** @typedef {import('./roles.js').ModelRole} ModelRole */
/** @typedef {import('./roles.js').PoolEntry} PoolEntry */
/** @typedef {import('./router.js').PurposeResult} PurposeResult */
/** @typedef {import('./router.js').RouterDeps} RouterDeps */

/** @typedef {'pending' | 'ok' | 'invalid' | 'error' | 'timeout' | 'skipped'} MemberStatus */

/**
 * @typedef {object} CouncilMember
 * @property {ProviderId} provider
 * @property {string} model             the model that served (the pinned one until it answers)
 * @property {MemberStatus} status
 * @property {string} [text]            the draft as text (a JSON answer as JSON text)
 * @property {unknown} [value]          purpose mode: the validated answer
 * @property {string[]} [errors]        why the draft was rejected (validation problems or the error code)
 * @property {number} [latencyMs]
 * @property {boolean} [thinking]
 */

/**
 * @typedef {object} CouncilJudge
 * @property {ProviderId} provider
 * @property {string} model
 * @property {'pending' | 'ok' | 'invalid' | 'error' | 'timeout' | 'skipped'} status
 * @property {number | null} chosen     index into `members`
 * @property {string[]} reasons
 * @property {boolean} merged           the judge wrote a merged answer that became the output
 * @property {number} [latencyMs]
 */

/**
 * @typedef {object} CouncilResult
 * @property {'purpose' | 'free'} mode
 * @property {string | null} purpose
 * @property {CouncilMember[]} members
 * @property {CouncilJudge | null} judge
 * @property {{ text?: string, value?: unknown } | null} output
 * @property {'judge' | 'merged' | 'best' | 'none'} decidedBy
 * @property {number} [bestIndex]       the member whose draft is the output (judge or best)
 * @property {number} validCount
 * @property {string} [fallbackReason]  no_models, no_valid_draft, one_valid_draft, no_judge, judge_<status>
 * @property {boolean} [thinking]
 * @property {number} startedAt         epoch ms
 * @property {number} [finishedAt]
 */

/** @typedef {'members' | 'judge' | 'done'} CouncilPhase */

/**
 * @typedef {object} CouncilOptions
 * @property {string} [purpose]          purpose mode: a purpose name ...
 * @property {unknown} [input]           ... and its input
 * @property {Message[]} [messages]      free mode: the conversation ...
 * @property {string} [system]           ... its system prompt
 * @property {string} [task]             what the judge is told the drafts answer (default: from the purpose or the last user turn)
 * @property {number} [members]          1-3, default 3
 * @property {PoolEntry[]} [pool]        the models to choose from (default: the configured providers' role models)
 * @property {boolean} [allowMerge]      the judge may merge drafts (default true)
 * @property {number} [maxTokens]        free mode: token limit of a draft
 * @property {number} [timeoutMs]        free mode: time limit of a draft (default 120 s)
 * @property {PromptLocale} [locale]
 * @property {boolean} [thinking]        default: the extended-thinking switch
 * @property {AbortSignal} [signal]      aborting rejects with an AbortError
 * @property {(result: CouncilResult, phase: CouncilPhase) => void} [onUpdate]
 * @property {(member: CouncilMember) => number} [score]  ranks valid drafts for "best" (default: the member's strength)
 * @property {Partial<RouterDeps> & { pool?: () => PoolEntry[] }} [deps]
 */

export const MAX_MEMBERS = 3;
/** Time limit of a free-chat draft. */
export const FREE_DRAFT_TIMEOUT_MS = 120_000;
const ON_DEVICE = new Set(['webgpu', 'wasm', 'local']);
/** Taken off an on-device model's strength: more than any cloud model scores, so cloud models rank first. */
const ON_DEVICE_PENALTY = 12;
/** Roles a member may come from after the purpose's own one. */
const MEMBER_ROLES = /** @type {const} */ (['reasoning', 'fast', 'judge']);

/**
 * How strong a model is for judging and as a tie-break between drafts.
 * @param {PoolEntry} entry
 * @param {((provider: ProviderId, model: string) => Caps | null)} [caps]
 */
export function strengthScore(entry, caps) {
  const c = caps?.(entry.provider, entry.model) ?? null;
  let score = 0;
  if (entry.roles.includes('judge')) score += 4;
  if (entry.roles.includes('reasoning')) score += 2;
  if (c && c.reasoning !== 'none') score += 2;
  if (c?.latency === 'slow') score += 1;
  else if (c?.latency === 'normal') score += 0.5;
  if (entry.roles.length === 1 && entry.roles[0] === 'fast') score -= 1;
  if (ON_DEVICE.has(entry.provider)) score -= ON_DEVICE_PENALTY;
  return score;
}

/**
 * @param {PoolEntry} a
 * @param {{ provider: ProviderId, model: string }} b
 */
const same = (a, b) => a.provider === b.provider && a.model === b.model;

/**
 * The strongest usable model of the pool that is not a member, or null.
 * @param {readonly PoolEntry[]} pool
 * @param {ReadonlyArray<{ provider: ProviderId, model: string }>} members
 * @param {{ usable?: (entry: PoolEntry) => boolean, caps?: (provider: ProviderId, model: string) => Caps | null }} [options]
 * @returns {PoolEntry | null}
 */
export function pickJudge(pool, members, options = {}) {
  let best = /** @type {PoolEntry | null} */ (null);
  let bestScore = -Infinity;
  for (const entry of pool) {
    if (members.some((m) => same(entry, m)) || (options.usable && !options.usable(entry)) || entry.roles.every((r) => r === 'vision')) continue;
    const score = strengthScore(entry, options.caps);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Up to `count` members: models of the purpose's role first, then the other text roles; one per
 * provider until every provider has one, then more from the same providers. The judge's pick stays
 * out while enough other models remain for min(count, 2) members.
 * @param {readonly PoolEntry[]} pool
 * @param {{ role?: ModelRole, count?: number, usable?: (entry: PoolEntry) => boolean, caps?: (provider: ProviderId, model: string) => Caps | null }} [options]
 * @returns {PoolEntry[]}
 */
export function pickMembers(pool, options = {}) {
  const role = options.role ?? 'reasoning';
  const count = Math.max(1, Math.min(MAX_MEMBERS, options.count ?? MAX_MEMBERS));
  const usable = pool.filter((e) => (!options.usable || options.usable(e)) && (role === 'vision' ? e.roles.includes('vision') : e.roles.some((r) => r !== 'vision')));
  /** @type {PoolEntry[]} */
  const ordered = [];
  for (const r of role === 'vision' ? ['vision'] : [role, ...MEMBER_ROLES.filter((x) => x !== role)]) {
    for (const e of usable) if (e.roles.includes(/** @type {ModelRole} */ (r)) && !ordered.includes(e)) ordered.push(e);
  }
  const judge = pickJudge(usable, [], { caps: options.caps });
  const rest = judge ? ordered.filter((e) => e !== judge) : ordered;
  const candidates = rest.length >= Math.min(count, 2) ? rest : ordered;
  /** @type {PoolEntry[]} */
  const picked = [];
  for (const e of candidates) if (picked.length < count && !picked.some((p) => p.provider === e.provider)) picked.push(e);
  for (const e of candidates) if (picked.length < count && !picked.includes(e)) picked.push(e);
  return picked;
}

/**
 * @param {CouncilResult} result
 * @returns {CouncilResult}
 */
const snapshot = (result) => structuredClone(result);

/** @returns {DOMException} */
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * The member status of a failed call.
 * @param {string | undefined} code
 * @returns {MemberStatus}
 */
const statusOfCode = (code) => (code === 'timeout' ? 'timeout' : code === 'refusal' ? 'invalid' : 'error');

/**
 * The member a purpose run became.
 * @param {PoolEntry} entry
 * @param {PurposeResult} res
 * @param {boolean} json
 * @returns {CouncilMember}
 */
function memberOfPurpose(entry, res, json) {
  const last = res.attempts.at(-1);
  const latencyMs = res.attempts.reduce((sum, a) => sum + a.latencyMs, 0);
  const base = { provider: entry.provider, model: res.model ?? last?.served ?? entry.model, latencyMs, ...(last?.thinking ? { thinking: true } : {}) };
  if (res.ok) {
    const out = json ? { value: res.value, text: JSON.stringify(res.value) } : { text: res.text ?? '' };
    return { ...base, status: 'ok', ...out };
  }
  if (!last) return { ...base, status: 'skipped', errors: [res.fallbackReason ?? 'unavailable'] };
  if (last.outcome === 'invalid' || last.outcome === 'truncated' || last.outcome === 'refused') return { ...base, status: 'invalid', errors: last.errors ?? [last.code ?? last.outcome] };
  if (last.outcome === 'skipped') return { ...base, status: 'skipped', errors: [last.blocked ?? 'unavailable'] };
  return { ...base, status: statusOfCode(last.code), errors: [last.code ?? last.outcome] };
}

/**
 * Runs a council. Never rejects, except with an AbortError when the signal aborts.
 * @param {CouncilOptions} options
 * @returns {Promise<CouncilResult>}
 */
export async function runCouncil(options) {
  const deps = routerDeps(options.deps);
  const def = options.purpose ? getPurpose(options.purpose) : null;
  if (options.purpose && !def) throw new TypeError(`unknown purpose: ${String(options.purpose).slice(0, 40)}`);
  if (!def && !Array.isArray(options.messages)) throw new TypeError('a council needs a purpose or messages');
  const locale = options.locale === 'de' || options.locale === 'en' ? options.locale : deps.locale();
  const thinking = options.thinking ?? isThinkingOn();
  const signal = options.signal;
  const json = Boolean(def?.jsonSchema);
  const usable = (/** @type {PoolEntry} */ e) => deps.wheel.blocked(e.provider, e.model) === null;
  const pool = options.pool ?? options.deps?.pool?.() ?? rolePool(deps.configured(), { live: deps.liveModels, pinned: getPinnedModel(), caps: deps.caps });

  /** @type {CouncilResult} */
  let result = { mode: def ? 'purpose' : 'free', purpose: def?.name ?? null, members: [], judge: null, output: null, decidedBy: 'none', validCount: 0, startedAt: deps.now(), ...(thinking ? { thinking: true } : {}) };
  /** @param {CouncilPhase} phase */
  const report = (phase) => {
    try {
      options.onUpdate?.(snapshot(result), phase);
    } catch {
      // the panel's failure must not end the council
    }
  };
  /** @param {Partial<CouncilResult>} final */
  const finish = (final) => {
    result = { ...result, ...final, finishedAt: deps.now() };
    report('done');
    return snapshot(result);
  };

  if (signal?.aborted) throw abortError();
  const chosen = pickMembers(pool, { role: def?.role ?? 'reasoning', count: options.members, usable, caps: deps.caps });
  if (!chosen.length) return finish({ fallbackReason: 'no_models' });
  const thinks = (/** @type {PoolEntry} */ e) => thinking && e.roles.some((r) => r === 'reasoning' || r === 'judge');
  result = { ...result, members: chosen.map((e) => ({ provider: e.provider, model: e.model, status: /** @type {MemberStatus} */ ('pending'), ...(thinks(e) ? { thinking: true } : {}) })) };
  report('members');

  /**
   * @param {PoolEntry} entry
   * @returns {Promise<CouncilMember>}
   */
  const draft = async (entry) => {
    if (def) {
      const res = await runPurpose(def.name, options.input, { provider: entry.provider, model: entry.model, fallback: false, cache: 'off', locale, signal, thinking: thinks(entry), deps: options.deps });
      return memberOfPurpose(entry, res, json);
    }
    return freeDraft(entry, options, { deps, thinking: thinks(entry), signal });
  };
  await Promise.all(
    chosen.map(async (entry, i) => {
      const member = await draft(entry);
      if (signal?.aborted) throw abortError();
      result = { ...result, members: result.members.map((m, j) => (j === i ? member : m)) };
      report('members');
    }),
  );

  const valid = result.members.map((m, i) => ({ m, i })).filter(({ m }) => m.status === 'ok');
  result = { ...result, validCount: valid.length };
  if (!valid.length) return finish({ fallbackReason: 'no_valid_draft' });
  // Members line up with `chosen`; the first of equally ranked drafts wins.
  const rank = (/** @type {number} */ i) => (options.score ? options.score(result.members[i]) : strengthScore(chosen[i], deps.caps));
  const best = valid.reduce((a, b) => (rank(b.i) > rank(a.i) ? b : a)).i;
  const bestOutput = () => outputOf(result.members[best]);
  if (valid.length === 1) return finish({ output: bestOutput(), decidedBy: 'best', bestIndex: best, fallbackReason: 'one_valid_draft' });

  const judgeEntry = pickJudge(pool, chosen, { usable, caps: deps.caps });
  if (!judgeEntry) return finish({ output: bestOutput(), decidedBy: 'best', bestIndex: best, fallbackReason: 'no_judge' });
  result = { ...result, judge: { provider: judgeEntry.provider, model: judgeEntry.model, status: 'pending', chosen: null, reasons: [], merged: false } };
  report('judge');

  const judgeInput = { task: options.task ?? taskOf(def, options, locale), drafts: valid.map(({ m }) => m.text ?? ''), allowMerge: options.allowMerge !== false };
  const verdict = await runPurpose('council_judge', judgeInput, { provider: judgeEntry.provider, model: judgeEntry.model, fallback: false, cache: 'off', locale, signal, thinking: thinks(judgeEntry), deps: options.deps });
  const judgeMember = memberOfPurpose(judgeEntry, verdict, true);
  if (!verdict.ok) {
    const status = /** @type {CouncilJudge['status']} */ (judgeMember.status === 'ok' ? 'error' : judgeMember.status);
    return finish({
      judge: { provider: judgeEntry.provider, model: judgeMember.model, status, chosen: null, reasons: [], merged: false, latencyMs: judgeMember.latencyMs },
      output: bestOutput(),
      decidedBy: 'best',
      bestIndex: best,
      fallbackReason: `judge_${status}`,
    });
  }
  const v = /** @type {{ chosen: number, reasons: string[], merged?: string }} */ (verdict.value);
  const pickedIndex = valid[v.chosen]?.i ?? best;
  /** @type {CouncilJudge} */
  const judge = { provider: judgeEntry.provider, model: judgeMember.model, status: 'ok', chosen: pickedIndex, reasons: v.reasons, merged: false, latencyMs: judgeMember.latencyMs };
  if (v.merged) {
    const merged = def ? def.validate(v.merged, options.input) : { ok: true, value: v.merged };
    if (merged.ok) return finish({ judge: { ...judge, merged: true }, output: def?.jsonSchema ? { value: merged.value, text: JSON.stringify(merged.value) } : { text: String(merged.value) }, decidedBy: 'merged', bestIndex: pickedIndex });
  }
  return finish({ judge, output: outputOf(result.members[pickedIndex]), decidedBy: 'judge', bestIndex: pickedIndex });
}

/**
 * @param {CouncilMember} member
 * @returns {{ text?: string, value?: unknown }}
 */
function outputOf(member) {
  return member.value !== undefined ? { value: member.value, text: member.text } : { text: member.text ?? '' };
}

/**
 * What the drafts answer, for the judge: the purpose's instructions and input, or the last user turn.
 * @param {ReturnType<typeof getPurpose>} def
 * @param {CouncilOptions} options
 * @param {PromptLocale} locale
 */
function taskOf(def, options, locale) {
  if (def) {
    return def
      .buildMessages(options.input, { locale })
      .map((m) => messageText(m).replace(/^\[\[[a-z-]+:[a-z0-9_]+\]\]\n?/, ''))
      .join('\n\n')
      .slice(0, 8000);
  }
  const lastUser = [...(options.messages ?? [])].reverse().find((m) => m.role === 'user');
  const parts = [options.system ?? '', lastUser ? messageText(lastUser) : ''].filter(Boolean);
  return parts.join('\n\n').slice(0, 8000);
}

/**
 * One free-chat draft: the conversation sent to one pinned model.
 * @param {PoolEntry} entry
 * @param {CouncilOptions} options
 * @param {{ deps: RouterDeps, thinking: boolean, signal?: AbortSignal }} ctx
 * @returns {Promise<CouncilMember>}
 */
async function freeDraft(entry, options, ctx) {
  const { deps, signal } = ctx;
  const base = { provider: entry.provider, model: entry.model };
  const blocked = deps.wheel.acquire(entry.provider, entry.model);
  if (blocked) return { ...base, status: 'skipped', errors: [blocked] };
  const caps = deps.caps(entry.provider, entry.model);
  const role = entry.roles.some((r) => r === 'reasoning' || r === 'judge') ? 'reasoning' : 'fast';
  const choice = thinkingFor({ provider: entry.provider, model: entry.model, caps, on: ctx.thinking, role, show: false });
  /** @type {AiRequest} */
  let req = { provider: entry.provider, model: entry.model, messages: withoutForeignOpaque(options.messages ?? [], entry.provider), timeoutMs: options.timeoutMs ?? FREE_DRAFT_TIMEOUT_MS };
  if (options.system) req.system = options.system;
  if (options.maxTokens) req.maxOutputTokens = options.maxTokens;
  if (!req.messages.length) req.messages = [{ role: 'user', content: [textPart(options.task ?? '')] }];
  req = applyThinking(req, choice);
  const t0 = deps.now();
  const res = await deps.complete(req, { signal }).result;
  const latencyMs = Math.max(0, Math.round(deps.now() - t0));
  if (signal?.aborted) {
    deps.wheel.release(entry.provider, entry.model);
    throw abortError();
  }
  const served = { ...base, model: res.model || entry.model, latencyMs, ...(choice.thinks ? { thinking: true } : {}) };
  if (res.error) {
    deps.wheel.failed(entry.provider, entry.model, res.error.code, { retryAfterMs: res.error.retryAfterMs, latencyMs, role });
    return { ...served, status: statusOfCode(res.error.code), errors: [res.error.code] };
  }
  deps.wheel.succeeded(entry.provider, entry.model, { latencyMs, role });
  if (res.stopReason === 'max_tokens') return { ...served, status: 'invalid', errors: ['truncated'] };
  if (res.stopReason === 'refusal') return { ...served, status: 'invalid', errors: ['refusal'] };
  const text = res.text.trim();
  return text ? { ...served, status: 'ok', text } : { ...served, status: 'invalid', errors: ['empty'] };
}

/**
 * @typedef {(result: CouncilResult, phase: CouncilPhase) => void} CouncilListener
 * @typedef {Promise<CouncilResult> & { subscribe: (fn: CouncilListener) => () => void }} CouncilRun
 */

/**
 * Starts a council that a panel can follow: the promise of runCouncil() plus subscribe(fn), which
 * replays the latest snapshot to a late subscriber.
 * @param {CouncilOptions} options
 * @returns {CouncilRun}
 */
export function liveCouncil(options) {
  /** @type {Set<CouncilListener>} */
  const listeners = new Set();
  /** @type {{ result: CouncilResult, phase: CouncilPhase } | null} */
  let last = null;
  const promise = runCouncil({
    ...options,
    onUpdate(result, phase) {
      last = { result, phase };
      options.onUpdate?.(result, phase);
      for (const fn of listeners) {
        try {
          fn(result, phase);
        } catch {
          // one listener must not stop the others
        }
      }
    },
  });
  return Object.assign(promise, {
    /** @param {CouncilListener} fn */
    subscribe(fn) {
      listeners.add(fn);
      if (last) fn(last.result, last.phase);
      return () => {
        listeners.delete(fn);
      };
    },
  });
}
