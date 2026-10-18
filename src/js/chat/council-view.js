// @ts-check
/**
 * @file The council in the chat: three models from different providers draft an answer to the same
 * question at once and a judge (a fourth model, the strongest one available) chooses a draft or
 * merges them (ai/council.js). The panel (ui/council-panel.js) shows the drafts and the judge's
 * decision in the conversation while it happens; the result becomes an answer under the question,
 * the newest branch, labelled with how it was decided ("the judge's choice", "merged by the
 * judge", or "best draft" when no judge could decide).
 *
 * - The question: a stored one (Council on a message: the answer's question) or a new one from the
 *   composer (stored with the result). The drafts get the request the thread's free route would
 *   send (thread.js prepareQuestion): the same system prompt, history and question. A question
 *   that stays on this device is not sent to a council.
 * - Members and judge come from the models that are set up: the providers' role models and the own
 *   server's first model. The model on this device takes no part: it writes one answer at a time,
 *   so the drafts and the judge would queue behind each other.
 * - The stored answer keeps a bounded copy of the council (members, drafts, the judge's reasons), so
 *   the thread shows how it was decided under the answer (an answer decorator) after a reload too.
 */
import { currentSessionId } from '../chat-store.js';
import { onAction } from '../dom.js';
import { formatNumber, setText } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { providerState, routeOf } from '../providers.js';
import { renderMarkdown } from '../render.js';
import { html, icon, label, raw } from '../ui/kit.js';
import { liveCouncil, MAX_MEMBERS } from '../ai/council.js';
import { getPinnedModel } from '../ai/model-selection.js';
import { rolePool } from '../ai/roles.js';
import { routerDeps } from '../ai/router.js';
import { patchChildren, panelParts, renderCouncilPanel } from '../ui/council-panel.js';
import { capsOf } from './runner.js';

/** @typedef {import('../ai/council.js').CouncilResult} CouncilResult */
/** @typedef {import('../ai/council.js').CouncilOptions} CouncilOptions */
/** @typedef {import('../ai/roles.js').PoolEntry} PoolEntry */
/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('./runner.js').Target} Target */

/** Characters of a draft the stored answer keeps. */
export const KEPT_DRAFT_CHARS = 4000;
/** Reasons of the judge the stored answer keeps, and their length. */
const KEPT_REASONS = 5;
const REASON_CHARS = 300;

// ---------------------------------------------------------------------------------------------
// Pool, result and stored copy (no DOM)
// ---------------------------------------------------------------------------------------------

/**
 * The council's pool: the providers' role models and the extra models (the own server), each model
 * once.
 * @param {readonly PoolEntry[]} base
 * @param {readonly PoolEntry[]} extras
 * @returns {PoolEntry[]}
 */
export function councilPool(base, extras) {
  /** @type {PoolEntry[]} */
  const out = [];
  for (const e of [...base, ...extras]) if (!out.some((o) => o.provider === e.provider && o.model === e.model)) out.push(e);
  return out;
}

/**
 * The pool of the models set up here.
 * @returns {PoolEntry[]}
 */
function setUpPool() {
  const deps = routerDeps();
  const base = rolePool(deps.configured(), { live: deps.liveModels, pinned: getPinnedModel(), caps: deps.caps });
  /** @type {PoolEntry[]} */
  const extras = [];
  if (routeOf('local') === 'local') {
    const model = deps.liveModels('local')?.[0] ?? providerState().serverModels[0];
    if (model) extras.push({ provider: 'local', model, roles: ['fast'], pinned: false });
  }
  return councilPool(base, extras);
}

/**
 * The model whose request the drafts share: the one with the smallest context among the cloud
 * models (the history then fits every member), else the first model.
 * @param {readonly PoolEntry[]} pool
 * @returns {Target | null}
 */
export function sharedTarget(pool) {
  const cloud = pool.filter((e) => e.provider !== 'webgpu' && e.provider !== 'wasm' && e.provider !== 'local');
  const list = cloud.length ? cloud : pool;
  if (!list.length) return null;
  const smallest = list.reduce((a, b) => ((capsOf(b.provider, b.model).contextTokens || Infinity) < (capsOf(a.provider, a.model).contextTokens || Infinity) ? b : a));
  const route = smallest.provider === 'webgpu' || smallest.provider === 'wasm' ? 'device' : routeOf(smallest.provider);
  return { provider: smallest.provider, model: smallest.model, route };
}

/**
 * Who wrote the council's answer: the judge for a merged one, else the member whose draft stands.
 * @param {CouncilResult} result
 * @returns {{ provider: ProviderId, model: string } | null}
 */
export function authorOf(result) {
  if (result.decidedBy === 'merged' && result.judge) return { provider: result.judge.provider, model: result.judge.model };
  const member = typeof result.bestIndex === 'number' ? result.members[result.bestIndex] : null;
  return member ? { provider: member.provider, model: member.model } : null;
}

/**
 * A bounded copy of a finished council, for the stored answer.
 * @param {CouncilResult} result
 * @returns {CouncilResult}
 */
export function keptCouncil(result) {
  return {
    mode: 'free',
    purpose: null,
    members: result.members.map((m) => ({
      provider: m.provider,
      model: m.model,
      status: m.status,
      ...(typeof m.latencyMs === 'number' ? { latencyMs: m.latencyMs } : {}),
      ...(m.thinking ? { thinking: true } : {}),
      ...(m.errors?.length ? { errors: m.errors.slice(0, 3).map((e) => String(e).slice(0, 80)) } : {}),
      ...(m.status === 'ok' && m.text ? { text: m.text.slice(0, KEPT_DRAFT_CHARS) } : {}),
    })),
    judge: result.judge ? { ...result.judge, reasons: result.judge.reasons.slice(0, KEPT_REASONS).map((r) => String(r).slice(0, REASON_CHARS)) } : null,
    output: null,
    decidedBy: result.decidedBy,
    ...(typeof result.bestIndex === 'number' ? { bestIndex: result.bestIndex } : {}),
    validCount: result.validCount,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    startedAt: result.startedAt,
    ...(typeof result.finishedAt === 'number' ? { finishedAt: result.finishedAt } : {}),
  };
}

/**
 * The stored answer of a finished council (null when it has no answer).
 * @param {CouncilResult} result
 * @param {NodeRecord} question
 * @returns {Omit<import('./store.js').NodeInput, 'parentId'> | null}
 */
export function councilAnswer(result, question) {
  const text = result.output?.text?.trim() ? result.output.text : '';
  const author = authorOf(result);
  if (!text || !author) return null;
  const route = author.provider === 'webgpu' || author.provider === 'wasm' ? 'device' : routeOf(author.provider);
  const durationMs = typeof result.finishedAt === 'number' ? Math.max(0, result.finishedAt - result.startedAt) : undefined;
  return {
    role: 'assistant',
    parts: [{ type: 'text', text }],
    opaque: [],
    model: author.model,
    provider: author.provider,
    label: 'free',
    usage: null,
    localOnly: question.localOnly || route === 'device',
    meta: {
      engine: route === 'device' ? 'client' : route === 'local' ? 'local' : route === 'pool' ? 'pool' : 'cloud',
      chat_mode: 'free',
      requested: author.model,
      route,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      stop_reason: 'end',
      council: keptCouncil(result),
    },
  };
}

/**
 * The label key of a council answer by how it was decided.
 * @param {CouncilResult['decidedBy']} decidedBy
 */
export function councilLabelKey(decidedBy) {
  return decidedBy === 'merged' ? 'canvas.council.label_merged' : decidedBy === 'judge' ? 'canvas.council.label_judge' : 'canvas.council.label_best';
}

// ---------------------------------------------------------------------------------------------
// In the chat
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} CouncilAsk
 * @property {string} [conversationId]
 * @property {string | null} [questionId]  a stored question
 * @property {string} [text]               a new question
 * @property {readonly PoolEntry[]} [pool] for tests (default: the models set up here)
 * @property {CouncilOptions['deps']} [deps]  for tests
 */

/** @type {AbortController | null} */
let running = null;
let wired = false;

/** Whether a council is running. */
export function isCouncilRunning() {
  return running !== null;
}

/**
 * A notice in the conversation (the thread's notice row).
 * @param {string} title
 * @param {string} [body]
 */
async function notice(title, body) {
  const { appendNotice } = await import('../messages.js');
  appendNotice({ icon: 'info', tone: 'info', title, ...(body ? { body } : {}) });
}

/**
 * The council's row in the conversation: the question (a new one), the live panel and Stop.
 * @param {string} question  shown for a new question
 * @returns {{ row: HTMLElement, panel: HTMLElement, stop: HTMLButtonElement }}
 */
function councilRow(question) {
  const row = document.createElement('div');
  row.className = 'message-row council-row w-full max-w-4xl mx-auto';
  row.dataset.role = 'council';
  row.innerHTML = html`<div class="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-xs">
    <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-sm font-semibold text-slate-900 flex items-center gap-2">${icon('network', 'w-4 h-4')}${label('canvas.council.heading')}</p><button type="button" class="btn btn-secondary px-2 py-1 text-xs" data-action="council-stop">${icon('square', 'w-3.5 h-3.5')}${label('canvas.council.stop')}</button></div>
    ${question ? html`<p class="text-sm text-slate-700 whitespace-pre-wrap break-words" data-council-question>${question}</p>` : ''}
    <div data-council-panel></div>
  </div>`.value;
  refreshIcons(row);
  return { row, panel: /** @type {HTMLElement} */ (row.querySelector('[data-council-panel]')), stop: /** @type {HTMLButtonElement} */ (row.querySelector('[data-action="council-stop"]')) };
}

/**
 * Waits until the thread writes no answer (a council result is stored after the running turn).
 * @param {() => boolean} busy
 * @param {number} [ms]
 */
async function idle(busy, ms = 120_000) {
  const end = Date.now() + ms;
  while (busy() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 200));
  return !busy();
}

/**
 * Asks the council a question in the chat. Resolves with the stored answer, or null (stopped, no
 * answer, refused).
 * @param {CouncilAsk} ask
 * @returns {Promise<NodeRecord | null>}
 */
export async function askCouncil(ask) {
  if (running) {
    await notice('canvas.council.already');
    return null;
  }
  const conversationId = ask.conversationId ?? currentSessionId();
  const thread = await import('./thread.js');
  if (thread.isThreadBusy()) {
    await notice('canvas.council.busy');
    return null;
  }
  /** @type {import('./thread.js').PreparedQuestion} */
  let prepared;
  try {
    prepared = await thread.prepareQuestion(ask.questionId ? { conversationId, questionId: ask.questionId } : { conversationId, text: ask.text ?? '' });
  } catch (err) {
    await notice(/** @type {any} */ (err)?.code === 'empty' ? 'canvas.council.need_question' : 'canvas.council.failed');
    return null;
  }
  if (prepared.staysOnDevice) {
    await notice('canvas.council.stays_on_device_title', 'canvas.council.stays_on_device_body');
    return null;
  }
  // The model on this device stays out (see the file comment), also from a pool that was handed in.
  const pool = [...(ask.pool ?? setUpPool())].filter((e) => e.provider !== 'webgpu' && e.provider !== 'wasm');
  const shared = sharedTarget(pool);
  const providers = new Set(pool.map((e) => e.provider));
  if (!shared || providers.size < 2) {
    await notice('canvas.council.need_providers_title', 'canvas.council.need_providers_body');
    return null;
  }
  const req = await prepared.build(shared);
  const controller = new AbortController();
  running = controller;
  // The council shows below the conversation on screen when it is the question's.
  const view = councilRow(prepared.stored ? '' : (prepared.question.parts.find((p) => p.type === 'text')?.text ?? '').toString());
  const box = document.getElementById('chatMessages');
  if (box && currentSessionId() === conversationId) box.append(view.row);
  view.row.scrollIntoView?.({ block: 'end' });
  const run = liveCouncil({
    messages: req.messages,
    ...(req.system ? { system: req.system } : {}),
    members: MAX_MEMBERS,
    pool,
    signal: controller.signal,
    ...(ask.deps ? { deps: ask.deps } : {}),
  });
  renderCouncilPanel(view.panel, run, { renderOutput: (output) => raw(`<div class="prose-custom text-sm break-words">${renderMarkdown(output.text ?? '')}</div>`) });
  /** @type {CouncilResult | null} */
  let result = null;
  try {
    result = await run;
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[starpi] the council failed', err);
  } finally {
    running = null;
    view.stop.remove();
  }
  if (!result) return null;
  const answer = councilAnswer(result, prepared.question);
  if (!answer) {
    await notice('canvas.council.failed', result.fallbackReason ? `ai-orchestration.council.reason.${result.fallbackReason}` : undefined);
    return null;
  }
  if (!(await idle(thread.isThreadBusy))) {
    await notice('canvas.council.busy');
    return null;
  }
  const node = await thread.adoptAnswer({ conversationId, question: prepared.question, stored: prepared.stored, answer });
  // The thread shows the stored answer with how the council decided; the live row has done its part.
  if (node) view.row.remove();
  return node;
}

/**
 * The council's label and how it decided, under an answer the council wrote (an answer decorator).
 * @param {HTMLElement} el
 * @param {NodeRecord} node
 */
export function decorateCouncil(el, node) {
  const council = /** @type {CouncilResult | undefined} */ ((/** @type {Record<string, unknown>} */ (node.meta ?? {})).council);
  const slot = el.querySelector('.message-provenance');
  if (!council || !Array.isArray(council.members) || !slot || slot.querySelector('[data-council-label]')) return;
  const wrap = document.createElement('div');
  wrap.className = 'mt-2 space-y-2';
  wrap.dataset.councilLabel = council.decidedBy;
  wrap.innerHTML = html`<span class="label-badge label-unchecked">${icon('network', '')}${label(councilLabelKey(council.decidedBy))}</span>
    <details class="disclosure"><summary>${icon('network', 'w-4 h-4 text-amber-600')}${label('canvas.council.details')}${icon('chevron-down', 'disclosure-chevron')}</summary><div class="disclosure-body space-y-3" data-council-details></div></details>`.value;
  slot.append(wrap);
  const details = /** @type {HTMLElement} */ (wrap.querySelector('[data-council-details]'));
  // The panel's parts of the finished council, drafts readable, without the result (it is the answer).
  patchChildren(
    details,
    panelParts(council, 'done', { showDrafts: true }).filter((p) => p.key !== 'result'),
  );
  const count = document.createElement('p');
  count.className = 'text-xs text-slate-600';
  setText(count, 'ai-orchestration.council.valid_count', { valid: formatNumber(council.validCount), total: formatNumber(council.members.length) });
  details.append(count);
  refreshIcons(wrap);
}

/** Registers the council's handlers (once). */
export function initCouncilView() {
  if (wired) return;
  wired = true;
  onAction('council-stop', () => running?.abort());
}
