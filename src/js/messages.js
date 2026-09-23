// @ts-check
// Chat message rendering. User text is escaped; assistant/model/database text is rendered through
// renderMarkdown() (marked + DOMPurify). UI chrome inside messages carries data-i18n keys, so a
// language switch re-labels it; message content itself stays as written. No inline handlers:
// toggles and citations use data-action delegation.
import { byId, onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { applyTranslations, formatNumber, setText, t } from './i18n/index.js';
import { citationSources, linkifyCitations } from './rag/citations.js';
import { escapeHtml, renderMarkdown } from './render.js';

/** @typedef {{ title: string, rank?: number | null }} Source */

/** @type {Node | null} */
let welcomeTemplate = null;

function container() {
  const el = byId('chatMessages');
  if (!el) throw new Error('#chatMessages missing');
  return el;
}

function scrollToBottom() {
  const el = container();
  el.scrollTop = el.scrollHeight;
}

export function initMessages() {
  const el = container();
  welcomeTemplate = el.firstElementChild ? el.firstElementChild.cloneNode(true) : null;
  onAction('toggle-thought', (btn) => toggleThought(btn));
}

/** Restores the welcome message only (new chat / before replaying history). */
export function resetMessages() {
  const el = container();
  el.replaceChildren(...(welcomeTemplate ? [welcomeTemplate.cloneNode(true)] : []));
  applyTranslations(el);
  refreshIcons(el);
  el.scrollTop = 0;
}

/**
 * Splits model output into an optional reasoning part (<think>, <thought>, <denkprozess>) and the answer.
 * @param {string} rawText
 */
export function splitReasoning(rawText) {
  const text = String(rawText ?? '');
  const tags = [/<denkprozess>([\s\S]*?)<\/denkprozess>/i, /<(?:thought|think)>([\s\S]*?)<\/(?:thought|think)>/i];
  for (const re of tags) {
    const match = text.match(re);
    if (match) {
      return { thoughts: match[1].trim(), answer: text.replace(re, '').replace(/<\/?antwort>/gi, '').trim() };
    }
  }
  return { thoughts: '', answer: text.replace(/<\/?antwort>/gi, '').trim() };
}

const PHASE_ICONS = ['search', 'sparkles', 'clipboard-list', 'zap'];
const PHASE_ROLES = ['trace.role_retrieval', 'trace.role_answer', 'trace.role_details', 'trace.role_details'];

/**
 * Renders a details/trace text (Markdown with ### headings) as a list of step cards.
 * @param {string} text
 */
export function formatThoughtSteps(text) {
  if (!text) return '';
  /** @type {Array<{ title: string, content: string[] }>} */
  const phases = [];
  /** @type {{ title: string, content: string[] } | null} */
  let current = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^#{1,4}\s*(.*)/) ?? line.match(/^(PHASE\s*\d+:?.*)/i);
    if (header) {
      if (current) phases.push(current);
      current = { title: header[1].trim(), content: [] };
    } else {
      current ??= { title: '', content: [] };
      if (line.trim()) current.content.push(line);
    }
  }
  if (current) phases.push(current);
  if (phases.length === 0) return renderMarkdown(text);

  return phases
    .map((p, idx) => {
      const body = p.content.join('\n');
      const role = PHASE_ROLES[idx] ?? 'trace.role_details';
      return `
        <div class="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-slate-800 flex items-center gap-1.5 text-xs">
              <i data-lucide="${PHASE_ICONS[idx % PHASE_ICONS.length]}" class="w-3.5 h-3.5 text-amber-600"></i>
              <span>${escapeHtml(p.title.replace(/^#+\s*/, '')) || escapeHtml(t(role))}</span>
            </span>
            <span class="badge badge-muted" data-i18n="${role}">${escapeHtml(t(role))}</span>
          </div>
          <div class="text-[12px] text-slate-600 pl-3 border-l-2 border-amber-400 leading-relaxed">
            ${renderMarkdown(body || '–')}
          </div>
        </div>`;
    })
    .join('');
}

/** @param {HTMLElement} btn */
function toggleThought(btn) {
  const box = btn.closest('.thought-container');
  if (!box) return;
  const body = box.querySelector('.thought-body');
  const chevron = box.querySelector('.thought-chevron');
  const statusText = box.querySelector('.thought-status-text');
  if (!body) return;
  const open = body.classList.contains('hidden');
  body.classList.toggle('hidden', !open);
  chevron?.classList.toggle('rotate-180', open);
  setText(statusText, open ? 'trace.hide' : 'trace.show');
  btn.setAttribute('aria-expanded', String(open));
}

/**
 * @param {string} trace
 * @param {number | null} durationMs
 */
function thoughtBlock(trace, durationMs) {
  const dur = durationMs ? `${formatNumber(durationMs / 1000, { maximumFractionDigits: 1 })} s` : '';
  return `
    <div class="thought-container mb-3 rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden">
      <button type="button" data-action="toggle-thought" aria-expanded="false" class="w-full px-3.5 py-2 flex items-center justify-between text-left text-slate-600 hover:text-slate-900 bg-slate-100/60 hover:bg-slate-100 transition select-none">
        <span class="flex items-center gap-2 text-xs font-semibold text-slate-800">
          <i data-lucide="lightbulb" class="w-3.5 h-3.5 text-amber-600"></i>
          <span data-i18n="trace.title">${escapeHtml(t('trace.title'))}</span>
        </span>
        <span class="flex items-center gap-2 text-[11px] text-slate-500">
          ${dur ? `<span class="font-mono">${escapeHtml(dur)}</span>` : ''}
          <span class="thought-status-text text-[11px] text-amber-800 font-semibold" data-i18n="trace.show">${escapeHtml(t('trace.show'))}</span>
          <i data-lucide="chevron-down" class="thought-chevron w-3.5 h-3.5 transition-transform duration-200 text-slate-600"></i>
        </span>
      </button>
      <div class="thought-body hidden p-3 border-t border-slate-200 space-y-2 bg-white">
        ${formatThoughtSteps(trace)}
      </div>
    </div>`;
}

/**
 * @param {string} badgeKey
 * @param {boolean} pulse
 */
function badgeBlock(badgeKey, pulse) {
  if (!badgeKey) return '';
  return `<div class="mt-2.5 pt-2 border-t border-slate-200 flex items-center gap-1.5 text-[11px] text-slate-500">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500${pulse ? ' animate-pulse' : ''}"></span>
      <span data-i18n="${escapeHtml(badgeKey)}">${escapeHtml(t(badgeKey))}</span>
    </div>`;
}

/**
 * Title-only source list, used for answers restored from history (their excerpts are not kept).
 * @param {Source[]} sources
 */
function sourcesBlock(sources) {
  if (!sources.length) return '';
  return `<div class="mt-3 pt-2.5 border-t border-slate-200 flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-medium text-slate-500 mr-1" data-i18n="chat.sources">${escapeHtml(t('chat.sources'))}</span>
      ${sources.map((s) => `<span class="badge badge-brand">${escapeHtml(s.title)}</span>`).join('')}
    </div>`;
}

const ASSISTANT_AVATAR =
  '<div class="w-8 h-8 rounded-lg bg-[#FFCA00] flex items-center justify-center text-slate-950 text-sm font-extrabold flex-shrink-0" aria-hidden="true">S</div>';
const USER_AVATAR =
  '<div class="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center text-white flex-shrink-0" aria-hidden="true"><i data-lucide="user" class="w-4 h-4"></i></div>';

/**
 * @typedef {object} MessageOptions
 * @property {Source[]} [sources]       title-only sources (restored history)
 * @property {string | null} [citations] citation scope id from registerCitations()
 * @property {string} [badge]           i18n key of the engine label
 * @property {string | null} [trace]
 * @property {number | null} [durationMs]
 */

/**
 * @param {HTMLElement} bubble
 * @param {MessageOptions} opts
 */
function attachSources(bubble, opts) {
  const row = citationSources(opts.citations ?? null);
  if (row) bubble.querySelector('.message-sources')?.replaceChildren(row);
  else if (opts.sources?.length) bubble.querySelector('.message-sources')?.insertAdjacentHTML('beforeend', sourcesBlock(opts.sources));
}

/**
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @param {MessageOptions} [opts]
 */
export function appendMessage(role, text, opts = {}) {
  const isUser = role === 'user';
  const msgDiv = document.createElement('div');
  msgDiv.className = `flex items-start gap-3 max-w-3xl ${isUser ? 'ml-auto flex-row-reverse' : ''}`;

  let mainText = text;
  let trace = opts.trace ?? null;
  if (!isUser) {
    const split = splitReasoning(text);
    mainText = split.answer;
    if (split.thoughts) trace = trace ? `${split.thoughts}\n\n${trace}` : split.thoughts;
  }

  const bodyHtml = isUser ? escapeHtml(text).replace(/\n/g, '<br>') : renderMarkdown(mainText);

  msgDiv.innerHTML = `
    ${isUser ? USER_AVATAR : ASSISTANT_AVATAR}
    <div class="flex-1 min-w-0 ${isUser ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-800'} rounded-2xl p-4 text-sm leading-relaxed shadow-xs">
      ${!isUser && trace ? thoughtBlock(trace, opts.durationMs ?? null) : ''}
      <div class="message-content ${isUser ? 'text-white break-words' : 'prose-custom break-words'}">${bodyHtml}</div>
      ${isUser ? '' : '<div class="message-sources"></div>'}
      ${isUser ? '' : badgeBlock(opts.badge ?? '', false)}
    </div>`;

  if (!isUser) {
    const content = /** @type {HTMLElement} */ (msgDiv.querySelector('.message-content'));
    linkifyCitations(content, opts.citations ?? null);
    attachSources(msgDiv, opts);
  }

  container().appendChild(msgDiv);
  refreshIcons(msgDiv);
  scrollToBottom();
  return msgDiv;
}

/**
 * A system notice (engine state, download confirmation results, errors). Plain text only; both
 * lines carry i18n keys so they follow the language switch.
 * @param {{ icon: string, tone: 'info' | 'success' | 'warn', title: string, body?: string, params?: Record<string, string | number> }} notice
 */
export function appendNotice(notice) {
  const tones = {
    info: 'bg-sky-50 border-sky-200 text-sky-950',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-950',
    warn: 'bg-amber-50 border-amber-200 text-amber-950',
  };
  const iconTones = { info: 'text-sky-600', success: 'text-emerald-600', warn: 'text-amber-600' };
  const div = document.createElement('div');
  div.className = 'flex items-start gap-3 max-w-3xl';
  div.setAttribute('role', 'status');
  div.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="flex-1 min-w-0 border rounded-2xl p-3.5 text-sm leading-relaxed flex gap-2.5 ${tones[notice.tone]}">
      <i data-lucide="${escapeHtml(notice.icon)}" class="w-4 h-4 mt-0.5 flex-shrink-0 ${iconTones[notice.tone]}"></i>
      <div class="space-y-1">
        <p class="notice-title font-semibold"></p>
        <p class="notice-body text-[13px] opacity-90"></p>
      </div>
    </div>`;
  setText(div.querySelector('.notice-title'), notice.title, notice.params);
  const body = div.querySelector('.notice-body');
  if (notice.body) setText(body, notice.body, notice.params);
  else body?.remove();
  container().appendChild(div);
  refreshIcons(div);
  scrollToBottom();
  return div;
}

/**
 * A message bubble that re-renders at most once per animation frame while tokens stream in.
 * @param {string} badgeKey i18n key of the engine label
 */
export function createStreamingMessage(badgeKey) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'flex items-start gap-3 max-w-3xl';
  msgDiv.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl p-4 text-slate-800 text-sm leading-relaxed shadow-xs">
      <div class="streaming-trace"></div>
      <div class="message-content prose-custom break-words"><span class="inline-block w-1.5 h-3.5 bg-[#FFCA00] animate-pulse"></span></div>
      <div class="message-sources"></div>
      ${badgeBlock(badgeKey, true)}
    </div>`;
  container().appendChild(msgDiv);
  scrollToBottom();

  const proseEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.message-content'));
  const traceEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.streaming-trace'));
  let pending = '';
  let frame = 0;

  const flush = () => {
    frame = 0;
    proseEl.innerHTML = renderMarkdown(splitReasoning(pending).answer || pending);
    scrollToBottom();
  };

  return {
    element: msgDiv,
    /** @param {string} text */
    update(text) {
      pending = text;
      if (!frame) frame = requestAnimationFrame(flush);
    },
    /**
     * @param {string} finalText
     * @param {{ citations: string | null, trace: string | null, durationMs: number | null }} meta
     */
    finalize(finalText, meta) {
      if (frame) cancelAnimationFrame(frame);
      pending = finalText;
      flush();
      linkifyCitations(proseEl, meta.citations);
      const split = splitReasoning(finalText);
      const fullTrace = [split.thoughts, meta.trace].filter(Boolean).join('\n\n');
      if (fullTrace) traceEl.innerHTML = thoughtBlock(fullTrace, meta.durationMs);
      attachSources(msgDiv, { citations: meta.citations });
      msgDiv.querySelector('.animate-pulse')?.classList.remove('animate-pulse');
      refreshIcons(msgDiv);
    },
    remove() {
      if (frame) cancelAnimationFrame(frame);
      msgDiv.remove();
    },
  };
}

/** @returns {() => void} removes the indicator */
export function appendLoading() {
  const div = document.createElement('div');
  div.className = 'flex items-start gap-3 max-w-3xl';
  div.setAttribute('role', 'status');
  div.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="bg-white border border-slate-200 rounded-2xl px-3.5 py-3 text-slate-800 text-xs flex items-center gap-2.5 shadow-xs">
      <span class="relative flex h-2.5 w-2.5" aria-hidden="true">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
      </span>
      <span class="font-medium text-slate-700" data-i18n="chat.thinking">${escapeHtml(t('chat.thinking'))}</span>
    </div>`;
  container().appendChild(div);
  scrollToBottom();
  return () => div.remove();
}
