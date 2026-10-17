// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Council panel: shows a council run (ai/council.js) while it happens. One card per member with its
// provider, model, state, time and, for a rejected draft, why it was rejected; the valid drafts can
// be opened. Then the judge with its reasons and the draft it chose (or that it merged them), then
// the result and how it was decided. Times are shown in the user's own time zone.
//
// Pass a run from liveCouncil() (a promise with subscribe()); a plain Promise<CouncilResult> works
// too and shows the result once it settles. The status line is one live region for the whole run,
// only its text changes. Each snapshot replaces only the parts whose markup changed, so an opened
// draft, the keyboard focus and a screen reader's position survive the updates.
import { setHtml } from '../dom.js';
import { formatDate, formatNumber, onLocaleChange } from '../i18n/index.js';
import { html, icon, label, labelText, raw } from './kit.js';

/** @typedef {import('../ai/council.js').CouncilResult} CouncilResult */
/** @typedef {import('../ai/council.js').CouncilMember} CouncilMember */
/** @typedef {import('../ai/council.js').CouncilPhase} CouncilPhase */
/** @typedef {import('../ai/council.js').CouncilListener} CouncilListener */
/** @typedef {import('./kit.js').Label} Label */
/** @typedef {import('./kit.js').SafeHtml} SafeHtml */
/** @typedef {Promise<CouncilResult> & { subscribe?: (fn: CouncilListener) => () => void }} CouncilRunLike */
/** @typedef {CouncilPhase | 'start' | 'aborted'} PanelPhase */

/**
 * @typedef {object} CouncilPanelOptions
 * @property {number} [members]            placeholder cards before the first snapshot (default 3)
 * @property {boolean} [showDrafts]        valid drafts can be opened (default true)
 * @property {(output: { text?: string, value?: unknown }, result: CouncilResult) => SafeHtml} [renderOutput]  the result's markup (default: escaped text or JSON)
 * @property {(result: CouncilResult) => void} [onDone]
 * @property {(result: CouncilResult, phase: CouncilPhase) => void} [onProgress]
 */

/** @typedef {{ key: string, html: string, children?: Part[] }} Part */

const NS = 'ai-orchestration.council';

/** A state as chip tone, icon and label. Every state shows an icon and a word. */
const STATUS = Object.freeze({
  pending: { tone: 'chip-neutral', icon: 'loader-2', key: `${NS}.status.pending` },
  ok: { tone: 'chip-ok', icon: 'check-circle-2', key: `${NS}.status.ok` },
  invalid: { tone: 'chip-danger', icon: 'octagon-alert', key: `${NS}.status.invalid` },
  error: { tone: 'chip-danger', icon: 'octagon-alert', key: `${NS}.status.error` },
  timeout: { tone: 'chip-warn', icon: 'triangle-alert', key: `${NS}.status.timeout` },
  skipped: { tone: 'chip-neutral', icon: 'circle-dashed', key: `${NS}.status.skipped` },
});

const HEAD = Object.freeze({ council: { icon: 'network' }, judge: { icon: 'shield-check' }, thinking: { icon: 'lightbulb' }, note: { icon: 'info' } });

/** Validation problems with their own text; the rest of a code is shown as its detail. */
const ERROR_KEYS = /** @type {Readonly<Record<string, string>>} */ (
  Object.freeze({
    empty: `${NS}.error.empty`,
    truncated: `${NS}.error.truncated`,
    too_long: `${NS}.error.too_long`,
    refusal: `${NS}.error.refusal`,
    no_json: `${NS}.error.no_json`,
    schema: `${NS}.error.schema`,
    quote_not_found: `${NS}.error.quote_not_found`,
    unknown_source: `${NS}.error.unknown_source`,
  })
);

/** Provider error codes (ai/errors.js) are worded by the AI namespace. */
const AI_ERROR_CODES = new Set(['auth', 'quota', 'rate_limited', 'not_found', 'bad_request', 'context_length', 'server', 'timeout', 'network', 'aborted', 'bad_response', 'cors', 'stream_cut']);
/** Why the wheel held a model back. */
const BLOCKED_CODES = new Set(['cooldown', 'circuit_open', 'probing', 'not_found']);

/**
 * The text of one rejection code: a validation problem, a provider error or a wheel state.
 * @param {string} code
 * @returns {Label}
 */
export function rejectionLabel(code) {
  const [prefix, ...rest] = String(code).split(':');
  const detail = rest.join(':').slice(0, 60);
  if (ERROR_KEYS[prefix]) return { key: ERROR_KEYS[prefix], params: { detail: detail || '–' } };
  if (BLOCKED_CODES.has(prefix) && !detail) return `ai-orchestration.blocked.${prefix}`;
  if (AI_ERROR_CODES.has(prefix)) return `ai.error.${prefix}`;
  return { key: `${NS}.error.other`, params: { code: String(code).slice(0, 60) } };
}

/**
 * @param {keyof typeof STATUS} status
 */
function statusChip(status) {
  const def = STATUS[status] ?? STATUS.pending;
  const spin = status === 'pending' ? 'animate-spin motion-reduce:animate-none' : '';
  return html`<span class="chip ${def.tone}" data-status="${status}">${icon(def.icon, spin)}${label(def.key)}</span>`;
}

/** @param {number} ms */
function formatLatency(ms) {
  return ms < 1000 ? `${formatNumber(Math.round(ms))} ms` : `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/**
 * A moment as the user's local time.
 * @param {number} at epoch ms
 */
export function formatMoment(at) {
  return formatDate(new Date(at), { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The default markup of a draft or result: text as paragraphs, a JSON value as formatted JSON.
 * @param {{ text?: string, value?: unknown }} output
 * @returns {SafeHtml}
 */
export function outputMarkup(output) {
  if (output.value !== undefined && typeof output.value !== 'string') {
    return html`<pre class="text-xs leading-relaxed text-slate-800 whitespace-pre-wrap break-words">${JSON.stringify(output.value, null, 2)}</pre>`;
  }
  const value = typeof output.value === 'string' ? output.value : (output.text ?? '');
  return html`<p class="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap break-words">${value}</p>`;
}

/**
 * @param {CouncilMember | null} member
 * @param {number} index
 * @param {{ chosen: boolean, used: boolean, showDrafts: boolean, render: (o: { text?: string, value?: unknown }) => SafeHtml }} ctx
 */
function memberCard(member, index, ctx) {
  const status = member?.status ?? 'pending';
  const title = label({ key: `${NS}.draft`, params: { n: formatNumber(index + 1) } }, { tag: 'p', className: 'text-xs font-semibold text-slate-600' });
  const who = member
    ? html`<p class="text-[13px] leading-snug text-slate-900 break-all"><span class="font-semibold">${member.provider}</span> <span class="font-mono">${member.model}</span></p>`
    : html`<p class="text-[13px] text-slate-500">…</p>`;
  const thinking = member?.thinking ? html`<p class="flex items-center gap-1 text-xs text-slate-700" data-member-thinking>${icon(HEAD.thinking.icon, 'w-3.5 h-3.5 flex-shrink-0')}${label(`${NS}.thinking`)}</p>` : '';
  const latency = member && status !== 'pending' && typeof member.latencyMs === 'number' ? label({ key: `${NS}.latency`, params: { time: formatLatency(member.latencyMs) } }, { tag: 'p', className: 'text-xs text-slate-600' }) : '';
  const errors =
    member && status !== 'ok' && status !== 'pending' && member.errors?.length
      ? html`<div class="text-xs text-rose-800 space-y-0.5">${label(`${NS}.rejected`, { tag: 'p', className: 'font-semibold' })}<ul class="list-disc pl-4 space-y-0.5">${member.errors.slice(0, 5).map((e) => html`<li>${label(rejectionLabel(e))}</li>`)}</ul></div>`
      : '';
  const mark = ctx.chosen
    ? html`<p class="chip chip-info" data-chosen>${icon('check-circle-2', '')}${label(`${NS}.chosen`)}</p>`
    : ctx.used
      ? html`<p class="chip chip-info" data-used>${icon('check-circle-2', '')}${label(`${NS}.used_best`)}</p>`
      : '';
  // data-draft and data-focus-key let a rebuilt card keep its opened draft and the focus.
  const draft =
    member && status === 'ok' && ctx.showDrafts
      ? html`<details class="disclosure" data-draft="${String(index)}"><summary data-focus-key="draft-${String(index)}">${label(`${NS}.read_draft`)}${icon('chevron-down', 'disclosure-chevron')}</summary><div class="disclosure-body">${ctx.render(member)}</div></details>`
      : '';
  const ring = ctx.chosen || ctx.used ? 'border-sky-300 ring-1 ring-inset ring-sky-300' : status === 'invalid' || status === 'error' ? 'border-rose-200' : 'border-slate-200';
  return html`<li class="min-w-0 rounded-xl border ${ring} bg-white p-3.5 space-y-2" data-member="${String(index)}" data-status="${status}"><div class="flex flex-wrap items-center justify-between gap-2">${title}${statusChip(status)}</div>${who}${thinking}${latency}${errors}${mark}${draft}</li>`;
}

/**
 * @param {CouncilResult} result
 * @param {PanelPhase} phase
 */
function judgeBlock(result, phase) {
  const judge = result.judge;
  if (!judge) {
    if (phase !== 'done' || !result.fallbackReason) return '';
    return html`<p class="text-sm text-slate-700 flex items-start gap-2" data-judge="none">${icon(HEAD.note.icon, 'w-4 h-4 mt-0.5 flex-shrink-0')}${label(`${NS}.reason.${result.fallbackReason}`)}</p>`;
  }
  const head = html`<div class="flex flex-wrap items-center justify-between gap-2"><p class="text-sm font-semibold text-slate-900 flex items-center gap-2">${icon(HEAD.judge.icon, 'w-4 h-4')}${label(`${NS}.judge`)}</p>${statusChip(judge.status)}</div><p class="text-[13px] leading-snug text-slate-900 break-all"><span class="font-semibold">${judge.provider}</span> <span class="font-mono">${judge.model}</span></p>`;
  if (judge.status === 'pending') return html`<div class="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5" data-judge data-status="pending">${head}${label(`${NS}.judge_pending`, { tag: 'p', className: 'text-sm text-slate-700' })}</div>`;
  const reasons = judge.reasons.length
    ? html`<div class="space-y-0.5">${label(`${NS}.judge_reasons`, { tag: 'p', className: 'text-xs font-semibold text-slate-600' })}<ul class="list-disc pl-4 text-sm text-slate-800 space-y-0.5" data-reasons>${judge.reasons.map((r) => html`<li>${r}</li>`)}</ul></div>`
    : '';
  const choice =
    judge.chosen !== null && judge.status === 'ok'
      ? label({ key: `${NS}.judge_chose`, params: { draft: labelText({ key: `${NS}.draft`, params: { n: formatNumber(judge.chosen + 1) } }) } }, { tag: 'p', className: 'text-xs text-slate-700' })
      : '';
  const merged = judge.merged ? label(`${NS}.judge_merged`, { tag: 'p', className: 'text-xs text-slate-700' }) : '';
  const failed = judge.status !== 'ok' ? html`${label(`${NS}.judge_failed`, { tag: 'p', className: 'text-xs text-amber-900' })}${result.fallbackReason ? label(`${NS}.reason.${result.fallbackReason}`, { tag: 'p', className: 'text-xs text-slate-700' }) : ''}` : '';
  return html`<div class="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2" data-judge data-status="${judge.status}">${head}${reasons}${choice}${merged}${failed}</div>`;
}

/**
 * @param {CouncilResult} result
 * @param {CouncilPanelOptions} opts
 */
function resultBlock(result, opts) {
  const decided = label(`${NS}.decided.${result.decidedBy}`, { className: 'chip chip-neutral' });
  const body = result.output ? (opts.renderOutput ? opts.renderOutput(result.output, result) : outputMarkup(result.output)) : '';
  const counts = result.members.length ? label({ key: `${NS}.valid_count`, params: { valid: formatNumber(result.validCount), total: formatNumber(result.members.length) } }, { tag: 'p', className: 'text-xs text-slate-600' }) : '';
  const finished = typeof result.finishedAt === 'number' ? label({ key: `${NS}.finished_at`, params: { time: formatMoment(result.finishedAt) } }, { tag: 'p', className: 'text-xs text-slate-600' }) : '';
  return html`<div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3" data-result data-decided-by="${result.decidedBy}"><div class="flex flex-wrap items-center gap-2">${label(`${NS}.result`, { tag: 'p', className: 'text-sm font-semibold text-slate-900 mr-1' })}${decided}</div>${body ? html`<div class="space-y-2.5" data-output>${body}</div>` : ''}${counts}${finished}</div>`;
}

/**
 * @param {CouncilResult | null} result
 * @param {PanelPhase} phase
 * @returns {Label}
 */
function statusLabel(result, phase) {
  if (phase === 'aborted') return `${NS}.phase_aborted`;
  if (phase === 'start' || !result) return `${NS}.phase_start`;
  if (phase === 'members') {
    const done = result.members.filter((m) => m.status !== 'pending').length;
    return { key: `${NS}.phase_members`, params: { done: formatNumber(done), total: formatNumber(result.members.length) } };
  }
  if (phase === 'judge') return { key: `${NS}.phase_judge`, params: { valid: formatNumber(result.validCount) } };
  return `${NS}.phase_done_${result.decidedBy === 'none' ? 'none' : result.decidedBy}`;
}

/**
 * The body below the status line as keyed parts.
 * @param {CouncilResult | null} result
 * @param {PanelPhase} phase
 * @param {CouncilPanelOptions} opts
 * @returns {Part[]}
 */
export function panelParts(result, phase, opts = {}) {
  const members = result?.members ?? [];
  const chosen = result?.judge?.status === 'ok' && result.decidedBy !== 'best' ? result.judge.chosen : null;
  const used = result?.decidedBy === 'best' ? (result.bestIndex ?? null) : null;
  const render = (/** @type {{ text?: string, value?: unknown }} */ o) => (opts.renderOutput && result ? opts.renderOutput(o, result) : outputMarkup(o));
  const placeholders = phase === 'start' ? Math.max(1, Math.min(3, opts.members ?? 3)) : 0;
  const cards = members.length
    ? members.map((m, i) => memberCard(m, i, { chosen: chosen === i, used: used === i, showDrafts: opts.showDrafts !== false, render }).value)
    : Array.from({ length: placeholders }, (_, i) => memberCard(null, i, { chosen: false, used: false, showDrafts: false, render }).value);
  /** @type {Part[]} */
  const parts = [];
  if (result?.thinking && members.length) parts.push({ key: 'thinking', html: html`<p class="flex items-center gap-1.5 text-xs font-semibold text-slate-700" data-thinking>${icon(HEAD.thinking.icon, 'w-3.5 h-3.5 flex-shrink-0')}${label('ai-orchestration.thinking.label')}</p>`.value });
  if (cards.length) {
    parts.push({
      key: 'members',
      html: html`<ol class="grid gap-3 lg:grid-cols-3" aria-label="${labelText(`${NS}.drafts_label`)}" data-i18n-aria="${NS}.drafts_label"></ol>`.value,
      children: cards.map((markup, i) => ({ key: `member-${i}`, html: markup })),
    });
  }
  const judge = result ? judgeBlock(result, phase) : '';
  if (judge) parts.push({ key: 'judge', html: judge.toString() });
  if (phase === 'done' && result) parts.push({ key: 'result', html: resultBlock(result, opts).value });
  return parts;
}

/** What each element of a panel was built from. @type {WeakMap<Element, { key: string, html: string }>} */
const builtFrom = new WeakMap();

/**
 * The drafts the user opened and the control that has the focus, inside `root`.
 * @param {Element} root
 */
function viewState(root) {
  const open = [...root.querySelectorAll('details[open][data-draft]')].map((d) => d.getAttribute('data-draft') ?? '');
  const active = root.ownerDocument.activeElement;
  return { open, focus: active && root.contains(active) ? active.getAttribute('data-focus-key') : null };
}

/**
 * @param {Element} root
 * @param {{ open: string[], focus: string | null }} state
 */
function restoreViewState(root, state) {
  // Both values come from this module's own markup (a draft index, "draft-<index>").
  for (const id of state.open) if (/^\d+$/.test(id)) root.querySelector(`details[data-draft="${id}"]`)?.setAttribute('open', '');
  if (state.focus && /^[\w-]+$/.test(state.focus)) /** @type {HTMLElement | null} */ (root.querySelector(`[data-focus-key="${state.focus}"]`))?.focus({ preventScroll: true });
}

/**
 * One part's element, built inside a detached element of the parent's kind (an <li> needs a list).
 * @param {Element} parent
 * @param {Part} part
 */
function buildElement(parent, part) {
  const holder = parent.ownerDocument.createElement(parent.tagName.toLowerCase());
  setHtml(holder, part.html);
  const el = holder.firstElementChild ?? parent.ownerDocument.createElement('div');
  builtFrom.set(el, { key: part.key, html: part.html });
  if (part.children) patchChildren(el, part.children);
  return el;
}

/**
 * Brings the children of `parent` in line with `parts`: unchanged elements stay as they are, a
 * rebuilt one gets its opened drafts and the focus back.
 * @param {Element} parent
 * @param {readonly Part[]} parts
 */
export function patchChildren(parent, parts) {
  const wanted = new Set(parts.map((p) => p.key));
  /** @type {Map<string, Element>} */
  const current = new Map();
  for (const el of [...parent.children]) {
    const key = builtFrom.get(el)?.key;
    if (key !== undefined && wanted.has(key) && !current.has(key)) current.set(key, el);
    else el.remove();
  }
  /** @type {Element | null} */
  let prev = null;
  for (const part of parts) {
    let el = current.get(part.key) ?? null;
    if (el && builtFrom.get(el)?.html === part.html) {
      if (part.children) patchChildren(el, part.children);
    } else {
      const fresh = buildElement(parent, part);
      if (el) {
        const state = viewState(el);
        el.replaceWith(fresh);
        restoreViewState(fresh, state);
      }
      el = fresh;
    }
    if (el.parentElement !== parent || el.previousElementSibling !== prev) parent.insertBefore(el, prev ? prev.nextElementSibling : parent.firstElementChild);
    prev = el;
  }
}

/** The run that owns a container; an older run never draws over a newer one. @type {WeakMap<Element, object>} */
const owners = new WeakMap();

/**
 * Renders a council run into `container` and keeps it current until the run settles.
 * @param {HTMLElement} container
 * @param {CouncilRunLike} run
 * @param {CouncilPanelOptions} [opts]
 */
export function renderCouncilPanel(container, run, opts = {}) {
  const token = {};
  owners.set(container, token);
  const mine = () => owners.get(container) === token;
  /** @type {{ result: CouncilResult | null, phase: PanelPhase }} */
  let view = { result: null, phase: 'start' };
  /** @type {{ root: Element, status: HTMLElement, body: Element, statusHtml: string } | null} */
  let frame = null;

  const draw = () => {
    const status = label(statusLabel(view.result, view.phase)).value;
    if (!frame || !container.contains(frame.root)) {
      setHtml(
        container,
        html`<section class="space-y-3" data-council-phase="${view.phase}"><p class="text-sm text-slate-700 flex items-center gap-2" role="status" aria-live="polite">${icon(HEAD.council.icon, 'w-4 h-4 flex-shrink-0')}<span data-council-status>${raw(status)}</span></p><div class="space-y-3" data-council-body></div></section>`.value,
      );
      const root = container.querySelector('[data-council-phase]');
      const statusEl = /** @type {HTMLElement | null} */ (root?.querySelector('[data-council-status]') ?? null);
      const body = root?.querySelector('[data-council-body]');
      frame = root && statusEl && body ? { root, status: statusEl, body, statusHtml: status } : null;
      if (!frame) return;
    } else {
      frame.root.setAttribute('data-council-phase', view.phase);
      if (frame.statusHtml !== status) {
        setHtml(frame.status, status);
        frame.statusHtml = status;
      }
    }
    patchChildren(frame.body, panelParts(view.result, view.phase, opts));
  };
  draw();

  const unsubscribe =
    typeof run.subscribe === 'function'
      ? run.subscribe((result, phase) => {
          if (!mine() || view.phase === 'done') return;
          view = { result, phase };
          draw();
          try {
            opts.onProgress?.(result, phase);
          } catch (err) {
            console.warn('[starpi] council progress listener failed', err);
          }
        })
      : null;
  // A language switch re-renders composed texts (numbers, times) in the new language.
  const offLocale = onLocaleChange(() => {
    if (!mine() || !container.isConnected) {
      offLocale();
      return;
    }
    draw();
  });

  run.then(
    (result) => {
      unsubscribe?.();
      if (!mine()) return;
      view = { result, phase: 'done' };
      draw();
      try {
        opts.onDone?.(result);
      } catch (err) {
        console.warn('[starpi] council listener failed', err);
      }
    },
    (err) => {
      unsubscribe?.();
      if (!mine()) return;
      view = { result: view.result, phase: 'aborted' };
      draw();
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[starpi] council run failed', err);
    },
  );
}

