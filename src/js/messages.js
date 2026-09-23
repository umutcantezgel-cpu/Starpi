// @ts-check
// Chat message rendering. User text is escaped; assistant/model/database text is rendered through
// renderMarkdown() (marked + DOMPurify). No inline handlers: toggles use data-action delegation.
import { byId, onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { escapeHtml, renderMarkdown, sanitizeModelNames } from './render.js';

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

const PHASE_ICONS = ['🔍', '✦', '📋', '⚡'];
const PHASE_ROLES = ['Suche', 'Antwort', 'Details', 'Details'];

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
      current ??= { title: 'Details', content: [] };
      if (line.trim()) current.content.push(line);
    }
  }
  if (current) phases.push(current);
  if (phases.length === 0) return renderMarkdown(sanitizeModelNames(text));

  return phases
    .map((p, idx) => {
      const body = p.content.join('\n');
      return `
        <div class="rounded-lg bg-slate-50 border border-slate-200/80 p-3 space-y-1.5 shadow-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="font-bold text-slate-800 flex items-center gap-1.5 text-xs">
              <span>${PHASE_ICONS[idx] ?? '✦'}</span>
              <span>${escapeHtml(p.title.replace(/^#+\s*/, ''))}</span>
            </span>
            <span class="text-[10px] text-slate-700 font-semibold bg-slate-200/80 px-2 py-0.5 rounded border border-slate-300/70">${PHASE_ROLES[idx] ?? 'Details'}</span>
          </div>
          <div class="text-[12px] text-slate-600 pl-4 border-l-2 border-amber-400 font-sans leading-relaxed">
            ${renderMarkdown(sanitizeModelNames(body) || '–')}
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
  if (statusText) statusText.textContent = open ? 'Einklappen' : 'Anzeigen';
  btn.setAttribute('aria-expanded', String(open));
}

/**
 * @param {string} trace
 * @param {number | null} durationMs
 */
function thoughtBlock(trace, durationMs) {
  const dur = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';
  return `
    <div class="thought-container mb-3 rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden shadow-xs">
      <button type="button" data-action="toggle-thought" aria-expanded="false" class="w-full px-3.5 py-2 flex items-center justify-between text-left text-slate-600 hover:text-slate-900 bg-slate-100/60 hover:bg-slate-100 transition select-none">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-slate-800 flex items-center gap-1.5">💡 Quellen & Verarbeitung einsehen</span>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
          <span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded text-[10px] font-sans font-medium">Details</span>
          ${dur ? `<span class="text-slate-500">${dur}</span>` : ''}
          <span class="thought-status-text text-[10px] text-amber-800 font-sans font-semibold hover:underline">Anzeigen</span>
          <i data-lucide="chevron-down" class="thought-chevron w-3.5 h-3.5 transition-transform duration-200 text-slate-600"></i>
        </div>
      </button>
      <div class="thought-body hidden p-3.5 space-y-2 text-slate-700 text-xs border-t border-slate-200 bg-white leading-relaxed">
        ${formatThoughtSteps(trace)}
      </div>
    </div>`;
}

/**
 * @param {string} badge
 * @param {boolean} pulse
 */
function badgeBlock(badge, pulse) {
  if (!badge) return '';
  return `<div class="mt-2.5 pt-2 border-t border-slate-200 flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500${pulse ? ' animate-pulse' : ''}"></span>
      <span>${escapeHtml(sanitizeModelNames(badge))}</span>
    </div>`;
}

/** @param {Source[]} sources */
function sourcesBlock(sources) {
  if (!sources.length) return '';
  return `<div class="mt-2.5 pt-2 border-t border-slate-200 flex flex-wrap gap-1.5">
      <span class="text-[10px] text-slate-500 mr-1 flex items-center gap-1"><i data-lucide="book-open" class="w-3 h-3"></i> Quellen:</span>
      ${sources
        .map((s) => `<span class="bg-amber-50 text-amber-950 border border-amber-200 text-[10px] px-2 py-0.5 rounded-full font-bold">${escapeHtml(s.title)}</span>`)
        .join('')}
    </div>`;
}

const ASSISTANT_AVATAR =
  '<div class="w-8 h-8 rounded-lg bg-[#FFCA00] border border-amber-400/40 flex items-center justify-center text-slate-950 text-sm font-black flex-shrink-0 shadow-xs">✦</div>';
const USER_AVATAR =
  '<div class="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-xs">U</div>';

/**
 * @typedef {object} MessageOptions
 * @property {Source[]} [sources]
 * @property {string} [badge]
 * @property {string | null} [trace]
 * @property {number | null} [durationMs]
 */

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

  const bodyHtml = isUser
    ? escapeHtml(text).replace(/\n/g, '<br>')
    : renderMarkdown(sanitizeModelNames(mainText));

  msgDiv.innerHTML = `
    ${isUser ? USER_AVATAR : ASSISTANT_AVATAR}
    <div class="flex-1 min-w-0 ${isUser ? 'bg-slate-900 text-white shadow-xs' : 'bg-white border border-slate-200/90 text-slate-800 shadow-xs'} rounded-2xl p-4 text-sm leading-relaxed">
      ${!isUser && trace ? thoughtBlock(trace, opts.durationMs ?? null) : ''}
      <div class="${isUser ? 'text-white break-words' : 'prose-custom break-words'}">${bodyHtml}</div>
      ${isUser ? '' : sourcesBlock(opts.sources ?? [])}
      ${isUser ? '' : badgeBlock(opts.badge ?? '', false)}
    </div>`;

  container().appendChild(msgDiv);
  refreshIcons(msgDiv);
  scrollToBottom();
  return msgDiv;
}

/**
 * A message bubble that re-renders at most once per animation frame while tokens stream in.
 * @param {string} badge
 */
export function createStreamingMessage(badge) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'flex items-start gap-3 max-w-3xl';
  msgDiv.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="flex-1 min-w-0 bg-white border border-slate-200/90 rounded-2xl p-4 text-slate-800 text-sm leading-relaxed shadow-xs">
      <div class="streaming-trace"></div>
      <div class="prose-custom break-words streaming-content"><span class="inline-block w-1.5 h-3.5 bg-[#FFCA00] animate-pulse"></span></div>
      <div class="streaming-sources"></div>
      ${badgeBlock(badge, true)}
    </div>`;
  container().appendChild(msgDiv);
  scrollToBottom();

  const proseEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.streaming-content'));
  const sourcesEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.streaming-sources'));
  const traceEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.streaming-trace'));
  let pending = '';
  let frame = 0;

  const flush = () => {
    frame = 0;
    proseEl.innerHTML = renderMarkdown(sanitizeModelNames(splitReasoning(pending).answer || pending));
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
     * @param {Source[]} sources
     * @param {string | null} trace
     * @param {number | null} durationMs
     */
    finalize(finalText, sources, trace, durationMs) {
      if (frame) cancelAnimationFrame(frame);
      pending = finalText;
      flush();
      const split = splitReasoning(finalText);
      const fullTrace = [split.thoughts, trace].filter(Boolean).join('\n\n');
      if (fullTrace) traceEl.innerHTML = thoughtBlock(fullTrace, durationMs);
      sourcesEl.innerHTML = sourcesBlock(sources);
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
  div.className = 'flex items-start gap-2.5 sm:gap-3 max-w-3xl';
  div.setAttribute('role', 'status');
  div.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-amber-400/20 border border-amber-300 flex items-center justify-center text-amber-900 text-sm font-bold flex-shrink-0 shadow-xs">✦</div>
    <div class="bg-white border border-slate-200 rounded-2xl p-3 text-slate-800 text-xs flex items-center gap-2.5 shadow-card">
      <span class="relative flex h-2.5 w-2.5">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
      </span>
      <div class="flex flex-col sm:flex-row sm:items-center gap-1">
        <span class="font-semibold text-slate-900">Starpi bereitet die Antwort vor...</span>
        <span class="text-slate-500 text-[11px]">(Wissensdatenbank wird abgeglichen)</span>
      </div>
    </div>`;
  container().appendChild(div);
  scrollToBottom();
  return () => div.remove();
}
