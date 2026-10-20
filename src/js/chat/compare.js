// @ts-check
/**
 * @file Compare in the chat side panel (#chat-aside, tab Compare): one question to 2 to 4 models at
 * once, their answers in columns side by side, each with its own Stop, its time, its tokens and a
 * cost hint. "Continue with this" makes one answer the newest branch under the question in the
 * conversation tree (thread.js adoptAnswer), so the chat goes on from there.
 *
 * - The question: a stored one (Compare on a message: the answer's question) or a new one typed
 *   here or taken from the composer (stored with the answer that is continued, with the context
 *   block that went out).
 * - Every model gets the request the thread's free route would send it (thread.js prepareQuestion):
 *   the same system prompt, the history it may see (turns that stay on this device only for the
 *   models here) and the question. Each column streams on its own (chat/runner.js runAnswer with
 *   that one model, no fallback to another), so one slow or failing model holds up no other.
 * - Each finished column is labelled as the thread labels a free answer (thread.js presentAnswer on
 *   the fields freeAnswerInput stores: "not checked", a stop before the end, the web pages it cites
 *   and their web check).
 * - Tools: the request offers the tools the thread's would, so a column's answer goes through the
 *   tool runner as the thread's does (hooks.js setToolRunner): the calls it stopped for run in the
 *   column, with their approval cards there, and the answer goes on after them; a web answer from
 *   a search pack is checked. Stop in the column stops its tool calls too. A question that stays
 *   on this device (a new one for models here and the own server only, or a stored one that
 *   stays) is offered only the tools that keep it here, and goes to no search service.
 * - A column whose answer stays on this device (the model here, the companion, or a question that
 *   stays) is marked so (data-stays-on-device); the canvas keeps a block taken from it on this
 *   device too.
 * - The paired companion is asked as the thread asks it (prepareQuestion builds that request and
 *   gives its adapter): the bare question in its own conversation, sources mode for a grounded
 *   question, free otherwise. Its column shows exactly the units its gate released so far (a
 *   withdrawal takes them away again), offers no tools, and keeps no stopped answer (the companion
 *   drops an abandoned turn too). Continued, its answer and a new question stay on this device.
 * - Models: the header picker's choices (models of this device that are not loaded stay out, as a
 *   download would start), different providers first.
 */
import { currentSessionId } from '../chat-store.js';
import { splitStreamingText } from '../chat-stream.js';
import { decorateCodeBlocks, setAnswerSource } from '../code-blocks.js';
import { byId, onAction, onChange, setHtml } from '../dom.js';
import { formatNumber, setText, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { modelLabel, providerLabel } from '../providers.js';
import { renderMarkdown } from '../render.js';
import { html, icon, label } from '../ui/kit.js';
import { estimateCostUsd } from '../ai/catalog/models.js';
import { single } from './hooks.js';
import { capsOf, chatCandidates, deviceModel, runAnswer } from './runner.js';

/** @typedef {import('./runner.js').Target} Target */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('./thread.js').PreparedQuestion} PreparedQuestion */
/** @typedef {'idle' | 'pending' | 'streaming' | 'done' | 'stopped' | 'failed'} ColumnStatus */

/** @typedef {{ value: string, label: string, provider: string }} ModelChoice */

/**
 * One column of a comparison.
 * @typedef {object} Column
 * @property {string} value           the picker value
 * @property {Target | null} target
 * @property {ColumnStatus} status
 * @property {string} text
 * @property {CompletionResult | null} result
 * @property {number} startedAt       performance.now() at the start
 * @property {number | null} firstMs  time to the first text
 * @property {number} durationMs
 * @property {AbortController | null} controller
 * @property {string | null} error    an i18n key
 * @property {NodeRecord | null} adopted  the stored answer once continued
 * @property {HTMLElement | null} el  the column's element (kept when the form renders again)
 */

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;
/** Routes that keep a question on this device: the model here, the own server, the paired companion. */
const ON_DEVICE_ROUTES = new Set(['device', 'local', 'companion']);

// ---------------------------------------------------------------------------------------------
// Models and numbers (no DOM state)
// ---------------------------------------------------------------------------------------------

/**
 * The models a comparison can ask: the header picker's choices without Auto, models of this device
 * that are not loaded (asking one would start a download), the device entry while no model is
 * loaded there, and the own server's "first model" while its models are listed one by one.
 * @param {HTMLSelectElement | null} picker
 * @param {{ deviceReady?: boolean }} [opts]
 * @returns {ModelChoice[]}
 */
export function pickerChoices(picker, opts = {}) {
  if (!picker) return [];
  /** @type {ModelChoice[]} */
  const out = [];
  for (const o of picker.querySelectorAll('option')) {
    const value = o.value;
    if (o.disabled || !value || value === 'auto' || value === 'council' || /^(?:webgpu|wasm):/.test(value) || out.some((c) => c.value === value)) continue;
    if (value === 'device' && !opts.deviceReady) continue;
    const at = value.indexOf(':');
    out.push({ value, label: (o.textContent ?? value).trim(), provider: value === 'device' ? 'device' : at > 0 ? value.slice(0, at) : value });
  }
  return out.some((c) => c.provider === 'local' && c.value !== 'local:*') ? out.filter((c) => c.value !== 'local:*') : out;
}

/**
 * The models a new comparison starts with: `first` (when it is a choice), then one per provider not
 * taken yet, then the remaining choices, `count` in all (fewer when fewer exist).
 * @param {readonly ModelChoice[]} choices
 * @param {number} count
 * @param {string} [first]
 * @returns {string[]}
 */
export function defaultChoices(choices, count, first) {
  /** @type {ModelChoice[]} */
  const picked = [];
  const start = choices.find((c) => c.value === first);
  if (start) picked.push(start);
  for (const c of choices) if (picked.length < count && !picked.includes(c) && !picked.some((p) => p.provider === c.provider)) picked.push(c);
  for (const c of choices) if (picked.length < count && !picked.includes(c)) picked.push(c);
  return picked.map((c) => c.value);
}

/**
 * The cost hint of an answer: what the provider reported, else an estimate from the model's
 * prices; nothing to pay on this device, on the own server and on the site's free models.
 * @param {Target} target
 * @param {CompletionResult['usage']} usage
 * @returns {{ key: string, params?: Record<string, string> }}
 */
export function costHint(target, usage) {
  if (target.route === 'device') return { key: 'canvas.compare.cost_device' };
  if (target.route === 'local') return { key: 'canvas.compare.cost_server' };
  if (target.route === 'pool') return { key: 'canvas.compare.cost_pool' };
  const usd = typeof usage?.costUsd === 'number' ? usage.costUsd : usage ? estimateCostUsd(usage, capsOf(target.provider, target.model)) : null;
  if (usd === null || usd === undefined) return { key: 'canvas.compare.cost_unknown' };
  return { key: 'canvas.compare.cost', params: { usd: formatNumber(usd, { maximumFractionDigits: usd < 0.01 ? 5 : 3 }) } };
}

/**
 * The time line of a column: how long the answer took and when its first text arrived.
 * @param {{ durationMs: number, firstMs: number | null }} column
 * @returns {{ key: string, params: Record<string, string> }}
 */
export function latencyLine(column) {
  const seconds = (/** @type {number} */ ms) => formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (column.firstMs === null) return { key: 'canvas.compare.latency', params: { seconds: seconds(column.durationMs) } };
  return { key: 'canvas.compare.latency_first', params: { seconds: seconds(column.durationMs), first: seconds(column.firstMs) } };
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} CompareDeps
 * @property {(tab?: string) => void} [openAside]
 * @property {typeof import('./runner.js').runAnswer} [runAnswer]  for tests
 */

/**
 * @type {{ el: HTMLElement | null, deps: CompareDeps, conversationId: string, questionId: string | null, text: string, values: string[], columns: Column[], prepared: PreparedQuestion | null, running: number, message: { key: string, params?: Record<string, string> } | null }}
 */
const state = { el: null, deps: {}, conversationId: '', questionId: null, text: '', values: [], columns: [], prepared: null, running: 0, message: null };
let wired = false;

/** The thread module (loaded with the panel's first comparison). */
const threadModule = () => import('./thread.js');

/** @returns {ModelChoice[]} */
function choices() {
  return pickerChoices(/** @type {HTMLSelectElement | null} */ (byId('engineSelector')), { deviceReady: Boolean(deviceModel()) });
}

/** @param {string} selector */
const find = (selector) => /** @type {HTMLElement | null} */ (state.el?.querySelector(selector) ?? null);

/**
 * A model's name as the picker shows it.
 * @param {string} value
 */
function choiceLabel(value) {
  return choices().find((c) => c.value === value)?.label ?? value;
}

/** The name of the model that answered a column. */
function servedLabel(/** @type {Column} */ col) {
  if (!col.target) return choiceLabel(col.value);
  const served = col.result?.model || col.target.model;
  return `${providerLabel(col.target.provider)} · ${modelLabel(col.target.provider, served)}`;
}

/** Shows a message above the columns (a live region). */
function showMessage() {
  const el = find('[data-compare-message]');
  if (!el) return;
  if (!state.message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  setText(el, state.message.key, state.message.params);
  el.hidden = false;
}

/**
 * @param {string} key
 * @param {Record<string, string>} [params]
 */
function say(key, params) {
  state.message = { key, params };
  showMessage();
}

/** The model rows of the form. */
function modelRows() {
  const all = choices();
  return state.values.map((value, i) => {
    const options = all.map((c) => html`<option value="${c.value}"${c.value === value ? html` selected` : ''}>${c.label}</option>`);
    const remove =
      state.values.length > MIN_COLUMNS
        ? html`<button type="button" class="btn btn-ghost btn-icon" data-action="compare-remove" data-arg="${String(i)}" aria-label="${t('canvas.compare.remove', { n: formatNumber(i + 1) })}" data-i18n-aria="canvas.compare.remove" data-i18n-params="${JSON.stringify({ n: formatNumber(i + 1) })}">${icon('x', 'w-3.5 h-3.5')}</button>`
        : '';
    return html`<div class="flex items-center gap-1.5"><label class="flex-1 min-w-0"><span class="sr-only" data-i18n="canvas.compare.model_n" data-i18n-params="${JSON.stringify({ n: formatNumber(i + 1) })}">${t('canvas.compare.model_n', { n: formatNumber(i + 1) })}</span><select class="field py-1 text-xs w-full" data-change="compare-model" data-arg="${String(i)}" data-compare-model>${options}</select></label>${remove}</div>`;
  });
}

/** Renders the form and the columns. */
function render() {
  const el = state.el;
  if (!el) return;
  const running = state.running > 0;
  const stored = Boolean(state.questionId);
  const canAdd = state.values.length < MAX_COLUMNS && choices().length > state.values.length;
  setHtml(
    el,
    html`<section class="space-y-3" data-compare>
      <div class="space-y-1">
        <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-1.5">${icon('columns-2', 'w-4 h-4')}${label('canvas.compare.heading')}</h3>
        ${label('canvas.compare.intro', { tag: 'p', className: 'text-xs text-slate-600' })}
      </div>
      <form class="space-y-2" data-compare-form>
        <label class="block"><span class="field-label" data-i18n="canvas.compare.question">${t('canvas.compare.question')}</span>${stored ? label('canvas.compare.question_from_chat', { className: 'ml-1 chip chip-neutral' }) : ''}<textarea class="field mt-1 text-sm min-h-[3.5rem] w-full" data-compare-question${stored || running ? html` readonly` : ''}>${state.text}</textarea></label>
        <fieldset class="space-y-1.5"${running ? html` disabled` : ''}><legend class="field-label" data-i18n="canvas.compare.models">${t('canvas.compare.models')}</legend>${modelRows()}</fieldset>
        <div class="flex flex-wrap items-center gap-1.5">
          ${canAdd && !running ? html`<button type="button" class="btn btn-ghost px-2 py-1 text-xs" data-action="compare-add">${icon('plus', 'w-3.5 h-3.5')}${label('canvas.compare.add')}</button>` : ''}
          <button type="submit" class="btn btn-primary px-3 py-1 text-xs ml-auto" data-compare-run${running ? html` disabled` : ''}>${icon('columns-2', 'w-3.5 h-3.5')}${label(state.columns.length ? 'canvas.compare.run_again' : 'canvas.compare.run')}</button>
        </div>
      </form>
      <p class="text-xs text-amber-900" role="status" aria-live="polite" data-compare-message hidden></p>
      <div class="grid grid-flow-col auto-cols-[minmax(15rem,1fr)] gap-3 overflow-x-auto pb-1" data-compare-columns></div>
    </section>`.value,
  );
  find('[data-compare-form]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void runCompare();
  });
  find('[data-compare-question]')?.addEventListener('input', (e) => {
    state.text = /** @type {HTMLTextAreaElement} */ (e.target).value;
  });
  showMessage();
  const host = find('[data-compare-columns]');
  state.columns.forEach((col, i) => {
    col.el ??= columnShell(i);
    host?.append(col.el);
    paintColumn(i);
  });
}

/** A status chip of a column. */
const STATUS = /** @type {Record<ColumnStatus, { tone: string, icon: string }>} */ ({
  idle: { tone: 'chip-neutral', icon: 'circle-dashed' },
  pending: { tone: 'chip-neutral', icon: 'loader-2' },
  streaming: { tone: 'chip-info', icon: 'loader-2' },
  done: { tone: 'chip-ok', icon: 'check-circle-2' },
  stopped: { tone: 'chip-warn', icon: 'square' },
  failed: { tone: 'chip-danger', icon: 'octagon-alert' },
});

/**
 * The element of one column, filled by paintColumn.
 * @param {number} i
 */
function columnShell(i) {
  const col = document.createElement('article');
  col.className = 'compare-column min-w-0 rounded-xl border border-slate-200 bg-white p-3 flex flex-col gap-2';
  col.dataset.column = String(i);
  col.innerHTML = html`<header class="flex items-start justify-between gap-2"><p class="text-xs font-semibold text-slate-900 break-all" data-column-model></p><span data-column-status></span></header>
    <div class="message-content prose-custom break-words text-sm min-h-[3rem]" data-column-body></div>
    <div class="message-provenance"></div>
    <p class="text-[11px] text-rose-800" data-column-error hidden></p>
    <div class="text-[11px] text-slate-600 font-mono space-y-0.5" data-column-stats></div>
    <div class="flex flex-wrap items-center gap-1.5 mt-auto" data-column-actions></div>`.value;
  return col;
}

/**
 * Brings one column's header, stats and buttons up to date (the body streams separately).
 * @param {number} i
 */
function paintColumn(i) {
  const col = state.columns[i];
  const el = col?.el;
  if (!col || !el) return;
  el.dataset.status = col.status;
  // An answer that stays on this device says so to whoever takes its content (the canvas).
  el.toggleAttribute('data-stays-on-device', col.target?.route === 'device' || col.target?.route === 'companion' || state.prepared?.question.localOnly === true);
  const model = /** @type {HTMLElement} */ (el.querySelector('[data-column-model]'));
  model.textContent = servedLabel(col);
  const chip = STATUS[col.status];
  const spin = col.status === 'pending' || col.status === 'streaming' ? ' animate-spin motion-reduce:animate-none' : '';
  setHtml(/** @type {HTMLElement} */ (el.querySelector('[data-column-status]')), html`<span class="chip ${chip.tone}">${icon(chip.icon, spin.trim())}${label(`canvas.compare.status.${col.status}`)}</span>`.value);
  const error = /** @type {HTMLElement} */ (el.querySelector('[data-column-error]'));
  error.hidden = !col.error;
  if (col.error) setText(error, col.error);
  const stats = /** @type {HTMLElement} */ (el.querySelector('[data-column-stats]'));
  stats.replaceChildren();
  if (col.status === 'done' || col.status === 'stopped') {
    const line = (/** @type {{ key: string, params?: Record<string, string> }} */ l) => {
      const p = document.createElement('p');
      setText(p, l.key, l.params);
      stats.append(p);
    };
    line(latencyLine(col));
    const usage = col.result?.usage;
    if (usage) line({ key: 'canvas.compare.tokens', params: { input: formatNumber(usage.input), output: formatNumber(usage.output) } });
    if (col.target) line(costHint(col.target, usage ?? null));
  }
  const actions = /** @type {HTMLElement} */ (el.querySelector('[data-column-actions]'));
  const name = servedLabel(col);
  if (col.status === 'pending' || col.status === 'streaming') {
    setHtml(actions, html`<button type="button" class="btn btn-secondary px-2 py-1 text-xs" data-action="compare-stop" data-arg="${String(i)}" aria-label="${t('canvas.compare.stop_aria', { model: name })}">${icon('square', 'w-3.5 h-3.5')}${label('canvas.compare.stop')}</button>`.value);
  } else if (col.adopted) {
    setHtml(actions, html`<p class="text-[11px] text-emerald-800 flex items-center gap-1">${icon('check', 'w-3.5 h-3.5')}${label('canvas.compare.continued')}</p>`.value);
  } else if ((col.status === 'done' || col.status === 'stopped') && col.result && col.text.trim()) {
    setHtml(actions, html`<button type="button" class="btn btn-primary px-2 py-1 text-xs" data-action="compare-continue" data-arg="${String(i)}" aria-label="${t('canvas.compare.continue_aria', { model: name })}">${icon('git-fork', 'w-3.5 h-3.5')}${label('canvas.compare.continue')}</button>`.value);
  } else actions.replaceChildren();
}

/**
 * Renders the streamed text of a column.
 * @param {number} i
 * @param {boolean} final
 */
function paintBody(i, final) {
  const col = state.columns[i];
  const body = /** @type {HTMLElement | null} */ (col?.el?.querySelector('[data-column-body]') ?? null);
  if (!col || !body) return;
  const view = splitStreamingText(col.text);
  body.innerHTML = renderMarkdown(final ? view.answer || col.text : view.answer);
  if (final) {
    void decorateCodeBlocks(body);
    setAnswerSource(body, view.answer || col.text);
  }
}

/**
 * Opens the comparison for a question: a stored one (questionId) or a new one (text), with the
 * models it starts with (`first`: the model to put first, e.g. the one that answered).
 * @param {{ conversationId?: string, questionId?: string | null, text?: string, first?: string }} input
 */
export function openCompare(input) {
  stopAll();
  state.conversationId = input.conversationId ?? currentSessionId();
  state.questionId = input.questionId ?? null;
  state.text = input.text ?? '';
  state.columns = [];
  state.prepared = null;
  state.message = null;
  const all = choices();
  state.values = defaultChoices(all, Math.min(3, Math.max(MIN_COLUMNS, all.length)), input.first);
  state.deps.openAside?.('compare');
  render();
  if (all.length < MIN_COLUMNS) say('canvas.compare.too_few_models');
}

/** Stops every running column. */
function stopAll() {
  for (const col of state.columns) col.controller?.abort();
}

/** Reads the form's model choices. */
function readValues() {
  const selects = /** @type {HTMLSelectElement[]} */ ([...(state.el?.querySelectorAll('[data-compare-model]') ?? [])]);
  if (selects.length) state.values = selects.map((s) => s.value);
  return state.values;
}

/**
 * Starts the comparison with the form's question and models.
 * @returns {Promise<void>}
 */
export async function runCompare() {
  if (state.running > 0) return;
  const values = readValues();
  const area = /** @type {HTMLTextAreaElement | null} */ (find('[data-compare-question]'));
  if (area && !state.questionId) state.text = area.value;
  if (!state.questionId && !state.text.trim()) {
    say('canvas.compare.need_question');
    return;
  }
  if (values.length < MIN_COLUMNS) {
    say('canvas.compare.need_models');
    return;
  }
  if (new Set(values).size !== values.length) {
    say('canvas.compare.duplicate');
    return;
  }
  const { parsePickerValue } = await import('../models/choices.js');
  /** @type {Array<Target | null>} */
  const targets = await Promise.all(
    values.map(async (value) => {
      const assistant = parsePickerValue(value)?.assistant;
      return assistant ? ((await chatCandidates(assistant))[0] ?? null) : null;
    }),
  );
  const thread = await threadModule();
  const onDevice = (/** @type {Target | null} */ tg) => tg !== null && ON_DEVICE_ROUTES.has(tg.route);
  try {
    state.prepared = await thread.prepareQuestion(
      state.questionId
        ? { conversationId: state.conversationId, questionId: state.questionId }
        : // A new question stays on this device when only models here answer it (asked of the
          // companion and the own server only, the companion gets it with its own class).
          { conversationId: state.conversationId, text: state.text, localOnly: targets.every(onDevice), forCompanion: targets.some((tg) => tg?.route === 'companion') && !targets.some((tg) => tg?.route === 'device') },
    );
  } catch (err) {
    console.warn('[starpi] the comparison could not start', err);
    say(/** @type {any} */ (err)?.code === 'not_found' ? 'canvas.compare.question_gone' : 'canvas.compare.failed');
    return;
  }
  state.message = null;
  state.columns = values.map((value, i) => ({ value, target: targets[i], status: /** @type {ColumnStatus} */ ('pending'), text: '', result: null, startedAt: performance.now(), firstMs: null, durationMs: 0, controller: new AbortController(), error: null, adopted: null, el: null }));
  state.running = state.columns.length;
  render();
  await Promise.all(state.columns.map((_, i) => runColumn(i)));
}

/**
 * Streams one column's answer. Every column counts down `state.running` once; the form comes back
 * when the last one is done.
 * @param {number} i
 */
async function runColumn(i) {
  const col = state.columns[i];
  const prepared = state.prepared;
  let frame = 0;
  try {
    if (!col || !prepared) return;
    const signal = /** @type {AbortController} */ (col.controller).signal;
    if (!col.target) {
      finish(i, 'failed', 'canvas.compare.no_model');
      return;
    }
    if (prepared.staysOnDevice && !ON_DEVICE_ROUTES.has(col.target.route)) {
      finish(i, 'failed', 'canvas.compare.stays_on_device');
      return;
    }
    const companion = col.target.provider === 'companion';
    const repaint = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), paintBody(i, false)));
    };
    try {
      const run = await (state.deps.runAnswer ?? runAnswer)({
        candidates: [col.target],
        signal,
        build: prepared.build,
        // The companion's column shows what its gate released so far, withdrawals included.
        adapterFor: (tg) =>
          prepared.adapterFor?.(tg, {
            onText: (text) => {
              col.text = text;
              repaint();
            },
          }),
        onStart: () => {
          col.status = 'streaming';
          paintColumn(i);
        },
        onEvent: (ev) => {
          if (ev.type !== 'text') return;
          if (col.firstMs === null) col.firstMs = Math.round(performance.now() - col.startedAt);
          if (companion) return;
          col.text += ev.delta;
          repaint();
        },
      });
      let result = run.result;
      // The tool runner sees the column's answer as it sees the thread's: tool calls it stopped for
      // run here (approval cards in the column) and the answer goes on after them. The companion
      // answers without the app's tools.
      if (single.tools && run.target && !signal.aborted && col.el && !companion) {
        const asked = run.target;
        const element = col.el;
        const after = await single
          .tools({
            result,
            request: () => prepared.build(asked),
            ctx: { ...prepared.ctx, target: asked },
            signal,
            view: {
              element,
              update: (next) => {
                col.text = next;
                if (!frame) frame = requestAnimationFrame(() => ((frame = 0), paintBody(i, false)));
              },
            },
          })
          .catch((err) => {
            if (!signal.aborted) console.warn('[starpi] the tools of a compared answer failed', err);
            return null;
          });
        if (after) result = after;
      }
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      col.result = result;
      // The companion's answer is the text its gate released; a stopped one is not kept.
      col.text = companion ? (signal.aborted ? '' : ((await threadModule()).companionTextOf(result) ?? '')) : result.text;
      col.durationMs = Math.round(performance.now() - col.startedAt);
      if (!col.text.trim()) {
        const code = result.error?.code ?? (result.stopReason === 'refusal' ? 'refusal' : 'bad_response');
        finish(i, signal.aborted ? 'stopped' : 'failed', signal.aborted ? null : `ai.error.${code}`);
        return;
      }
      paintBody(i, true);
      finish(i, signal.aborted ? 'stopped' : 'done', null);
      if (col.el) {
        const thread = await threadModule();
        thread.presentAnswer(col.el, provisionalNode(col, prepared, thread));
      }
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      col.durationMs = Math.round(performance.now() - col.startedAt);
      const code = /** @type {any} */ (err)?.code;
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[starpi] a compared answer failed', err);
      finish(i, signal.aborted ? 'stopped' : 'failed', code === 'stays_on_device' ? 'canvas.compare.stays_on_device' : signal.aborted ? null : 'canvas.compare.failed');
    }
  } finally {
    state.running = Math.max(0, state.running - 1);
    // The form comes back once every column is done; the columns keep their content.
    if (state.running === 0) render();
  }
}

/**
 * @param {number} i
 * @param {ColumnStatus} status
 * @param {string | null} error
 */
function finish(i, status, error) {
  const col = state.columns[i];
  if (!col) return;
  col.status = status;
  col.error = error;
  col.controller = null;
  paintColumn(i);
}

/**
 * A column's answer as it would be stored (for its labels: the web pages it cites, its grounding
 * suggestions, a stop before the end), from the fields the thread stores for a free answer.
 * @param {Column} col
 * @param {PreparedQuestion} prepared
 * @param {typeof import('./thread.js')} thread
 * @returns {NodeRecord}
 */
function provisionalNode(col, prepared, thread) {
  const answer = thread.freeAnswerInput({
    question: prepared.question,
    target: /** @type {Target} */ (col.target),
    result: /** @type {CompletionResult} */ (col.result),
    durationMs: col.durationMs,
    aborted: col.status === 'stopped',
  });
  return {
    ...answer,
    id: `compare-${state.columns.indexOf(col)}`,
    conversationId: state.conversationId,
    parentId: prepared.question.id,
    opaque: answer.opaque ?? [],
    model: answer.model ?? null,
    provider: answer.provider ?? null,
    label: answer.label ?? 'free',
    usage: answer.usage ?? null,
    localOnly: answer.localOnly === true,
    createdAt: Date.now(),
  };
}

/**
 * "Continue with this": the column's answer becomes the newest branch under its question.
 * @param {number} i
 */
async function continueWith(i) {
  const col = state.columns[i];
  const prepared = state.prepared;
  if (!col?.result || !col.target || !prepared || col.adopted || !col.text.trim()) return;
  const thread = await threadModule();
  if (thread.isThreadBusy()) {
    say('canvas.compare.busy');
    return;
  }
  const answer = thread.freeAnswerInput({
    question: prepared.question,
    target: col.target,
    result: col.result,
    durationMs: col.durationMs,
    aborted: col.status === 'stopped',
    meta: { compare: { models: state.columns.length, column: i + 1 } },
  });
  // The chat on screen becomes the question's, so the branch shows where it was added.
  if (currentSessionId() !== state.conversationId) await (await import('../chat.js')).openConversation(state.conversationId);
  const node = await thread.adoptAnswer({ conversationId: state.conversationId, question: prepared.question, stored: prepared.stored, answer });
  if (!node) {
    say('canvas.compare.busy');
    return;
  }
  col.adopted = node;
  // The question is stored now: another column continues under the same one, as it was stored
  // (under the companion's answer it stays on this device, and so do the answers taken after it).
  if (!prepared.stored && node.parentId) {
    const questionId = node.parentId;
    state.prepared = await thread.prepareQuestion({ conversationId: state.conversationId, questionId }).catch(() => ({ ...prepared, stored: true, question: { ...prepared.question, id: questionId } }));
    state.questionId = questionId;
  }
  paintColumn(i);
  say('canvas.compare.continued_status', { model: servedLabel(col) });
}

/**
 * The note under an answer that was chosen in a comparison (an answer decorator).
 * @param {HTMLElement} el
 * @param {NodeRecord} node
 */
export function decorateCompared(el, node) {
  const info = /** @type {{ models?: unknown } | undefined} */ ((/** @type {Record<string, unknown>} */ (node.meta ?? {})).compare);
  const slot = el.querySelector('.message-provenance');
  if (!info || typeof info.models !== 'number' || !slot || slot.querySelector('[data-compared]')) return;
  const note = document.createElement('p');
  note.className = 'mt-2 flex items-center gap-1.5 text-[11px] text-slate-600';
  note.dataset.compared = '';
  const glyph = document.createElement('i');
  glyph.dataset.lucide = 'columns-2';
  glyph.className = 'w-3.5 h-3.5 flex-shrink-0';
  const text = document.createElement('span');
  setText(text, 'canvas.compare.chosen_note', { n: formatNumber(info.models) });
  note.append(glyph, text);
  slot.append(note);
  refreshIcons(note);
}

/**
 * Mounts the comparison into its panel (the handlers are registered once).
 * @param {HTMLElement} el
 * @param {CompareDeps} [deps]
 */
export function mountCompare(el, deps = {}) {
  state.el = el;
  state.deps = deps;
  if (!state.values.length) {
    state.conversationId ||= currentSessionId();
    const all = choices();
    state.values = defaultChoices(all, Math.min(3, Math.max(MIN_COLUMNS, all.length)));
  }
  render();
  if (wired) return;
  wired = true;
  onAction('compare-add', () => {
    readValues();
    const next = defaultChoices(choices(), state.values.length + 1).find((v) => !state.values.includes(v));
    if (next && state.values.length < MAX_COLUMNS) state.values.push(next);
    render();
  });
  onAction('compare-remove', (btn) => {
    readValues();
    const i = Number(btn.dataset.arg);
    if (state.values.length > MIN_COLUMNS && Number.isInteger(i)) state.values.splice(i, 1);
    render();
  });
  onChange('compare-model', () => void readValues());
  onAction('compare-stop', (btn) => state.columns[Number(btn.dataset.arg)]?.controller?.abort());
  onAction('compare-continue', (btn) => continueWith(Number(btn.dataset.arg)));
}

/** What the comparison shows (for tests). */
export function compareState() {
  return { conversationId: state.conversationId, questionId: state.questionId, text: state.text, values: [...state.values], running: state.running, columns: state.columns.map((c) => ({ value: c.value, status: c.status, text: c.text, error: c.error, adopted: c.adopted?.id ?? null })) };
}
