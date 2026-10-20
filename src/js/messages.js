// @ts-check
// Chat message rendering. User text is escaped; assistant/model/database text is rendered through
// renderMarkdown() (marked + DOMPurify). UI chrome inside messages carries data-i18n keys, so a
// language switch re-labels it; message content itself stays as written. No inline handlers:
// toggles and citations use data-action delegation.
//
// A message row carries the id of the stored message it shows (data-node-id) and has slots the
// thread fills: .message-actions (copy, regenerate, edit, branches), .message-provenance (labels,
// source check, receipt) and .message-meta (usage and latency). A model's reasoning is only ever
// shown inside the collapsible details block (thoughtBlock), while streaming as well.
import { splitReasoning, splitStreamingText } from './chat-stream.js';
import { decorateCodeBlocks, initCodeBlocks, setAnswerSource } from './code-blocks.js';
import { byId, onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { applyTranslations, formatNumber, setText, t } from './i18n/index.js';
import { citationSources, linkifyCitations } from './rag/citations.js';
import { clearGroundingHighlights } from './rag/grounding-view.js';
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
  initCodeBlocks();
}

/** Restores the welcome message only (new chat / before replaying history). */
export function resetMessages() {
  clearGroundingHighlights();
  const el = container();
  el.replaceChildren(...(welcomeTemplate ? [welcomeTemplate.cloneNode(true)] : []));
  applyTranslations(el);
  refreshIcons(el);
  el.scrollTop = 0;
}

const PHASE_ICONS = ['search', 'sparkles', 'clipboard-list', 'zap'];
/** i18n keys naming the phases of a trace, in order (a grounded answer: retrieval, then answer). */
const PHASE_ROLES = ['trace.role_retrieval', 'trace.role_answer', 'trace.role_details', 'trace.role_details'];

/**
 * The phase roles of a trace that may start with the model's own reasoning.
 * @param {string} thoughts
 * @param {string[] | undefined} roles
 */
function rolesWithReasoning(thoughts, roles = PHASE_ROLES) {
  return thoughts ? ['trace.role_reasoning', ...roles] : roles;
}

/**
 * Renders a details/trace text (Markdown with ### headings) as a list of step cards.
 * @param {string} text
 * @param {string[]} [roles]  i18n keys of the phases, in order
 */
export function formatThoughtSteps(text, roles = PHASE_ROLES) {
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
      const role = roles[idx] ?? 'trace.role_details';
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
 * @param {string[]} roles
 */
function thoughtBlock(trace, durationMs, roles) {
  const dur = durationMs ? `${formatNumber(durationMs / 1000, { maximumFractionDigits: 1 })} s` : '';
  return `
    <div class="thought-container mb-3 rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden">
      <button type="button" data-action="toggle-thought" aria-expanded="false" class="w-full px-3.5 py-2 flex items-center justify-between text-left text-slate-600 hover:text-slate-900 bg-slate-100/60 hover:bg-slate-100 transition select-none">
        <span class="flex items-center gap-2 text-xs font-semibold text-slate-800">
          <i data-lucide="lightbulb" class="w-3.5 h-3.5 text-amber-600"></i>
          <span data-i18n="trace.title">${escapeHtml(t('trace.title'))}</span>
        </span>
        <span class="flex items-center gap-2 text-[11px] text-slate-600">
          ${dur ? `<span class="font-mono">${escapeHtml(dur)}</span>` : ''}
          <span class="thought-status-text text-[11px] text-amber-800 font-semibold" data-i18n="trace.show">${escapeHtml(t('trace.show'))}</span>
          <i data-lucide="chevron-down" class="thought-chevron w-3.5 h-3.5 transition-transform duration-200 text-slate-600"></i>
        </span>
      </button>
      <div class="thought-body hidden p-3 border-t border-slate-200 space-y-2 bg-white">
        ${formatThoughtSteps(trace, roles)}
      </div>
    </div>`;
}

/**
 * The engine badge under an answer; setBadgeLabel() fills in its label.
 * @param {string} badgeKey
 * @param {boolean} pulse
 */
function badgeBlock(badgeKey, pulse) {
  if (!badgeKey) return '';
  return `<div class="mt-2.5 pt-2 border-t border-slate-200 flex items-center gap-1.5 text-[11px] text-slate-600">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500${pulse ? ' animate-pulse' : ''}"></span>
      <span class="engine-badge-label"></span>
    </div>`;
}

/**
 * Labels the engine badge. A model name arrives only as a parameter, never as an i18n key.
 * @param {HTMLElement} msgDiv
 * @param {string} badgeKey
 * @param {Record<string, string> | undefined} badgeParams
 */
function setBadgeLabel(msgDiv, badgeKey, badgeParams) {
  if (badgeKey) setText(msgDiv.querySelector('.engine-badge-label'), badgeKey, badgeParams);
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

const ASSISTANT_AVATAR = '<div class="brand-mark w-8 h-8 text-sm flex-shrink-0" aria-hidden="true">S</div>';
const USER_AVATAR =
  '<div class="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center text-white flex-shrink-0" aria-hidden="true"><i data-lucide="user" class="w-4 h-4"></i></div>';

/**
 * An attachment as a message shows it: a name with an icon (images and documents alike; the
 * thread never shows the image itself, which stays a blob on this device).
 * @typedef {{ name: string, kind: 'image' | 'file', detail?: string }} AttachmentChip
 */

/**
 * @typedef {object} MessageOptions
 * @property {Source[]} [sources]       title-only sources (restored history)
 * @property {string | null} [citations] citation scope id from registerCitations()
 * @property {string} [badge]           i18n key of the engine label
 * @property {Record<string, string>} [badgeParams] parameters of the engine label
 * @property {string | null} [trace]
 * @property {number | null} [durationMs]
 * @property {string[]} [traceRoles]    i18n keys of the trace phases (default: retrieval, answer)
 * @property {string} [reasoning]       the model's own reasoning (shown in the details only)
 * @property {string} [nodeId]          the stored message this element shows
 * @property {AttachmentChip[]} [attachments]
 * @property {string} [meta]            usage and latency line under an answer (already formatted)
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
 * Chips naming the files and images of a message.
 * @param {AttachmentChip[]} list
 * @param {boolean} onDark the chips sit on the dark bubble of a question
 */
export function attachmentChips(list, onDark = false) {
  const row = document.createElement('div');
  row.className = 'message-attachments flex flex-wrap gap-1.5 mb-2';
  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = `attachment-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] max-w-full ${onDark ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-700'}`;
    const icon = document.createElement('i');
    icon.dataset.lucide = a.kind === 'image' ? 'file' : 'file-text';
    icon.className = 'w-3 h-3 flex-shrink-0';
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = a.detail ? `${a.name} · ${a.detail}` : a.name;
    chip.append(icon, name);
    row.append(chip);
  }
  return row;
}

/**
 * The usage and latency line of an answer (plain text, set as text).
 * @param {HTMLElement} msgDiv
 * @param {string} text
 */
export function setMessageMeta(msgDiv, text) {
  const el = msgDiv.querySelector('.message-meta');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

/**
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @param {MessageOptions} [opts]
 */
export function appendMessage(role, text, opts = {}) {
  const isUser = role === 'user';
  const msgDiv = document.createElement('div');
  msgDiv.className = `message-row flex items-start gap-3 w-full max-w-4xl mx-auto ${isUser ? 'flex-row-reverse' : ''}`;
  msgDiv.dataset.role = role;
  if (opts.nodeId) msgDiv.dataset.nodeId = opts.nodeId;

  let mainText = text;
  let trace = opts.trace ?? null;
  let roles = opts.traceRoles ?? PHASE_ROLES;
  if (!isUser) {
    const split = splitReasoning(text);
    mainText = split.answer;
    const thoughts = [split.thoughts, opts.reasoning ?? ''].filter((x) => x.trim()).join('\n\n');
    if (thoughts) trace = trace ? `${thoughts}\n\n${trace}` : thoughts;
    roles = rolesWithReasoning(thoughts, opts.traceRoles);
  }

  const bodyHtml = isUser ? escapeHtml(text).replace(/\n/g, '<br>') : renderMarkdown(mainText);

  msgDiv.innerHTML = `
    ${isUser ? USER_AVATAR : ASSISTANT_AVATAR}
    <div class="message-bubble flex-1 min-w-0 ${isUser ? 'sm:max-w-[85%] bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-800'} rounded-2xl p-4 text-sm leading-relaxed shadow-xs">
      ${!isUser && trace ? thoughtBlock(trace, opts.durationMs ?? null, roles) : ''}
      <div class="message-content ${isUser ? 'text-white break-words' : 'prose-custom break-words'}">${bodyHtml}</div>
      ${isUser ? '' : '<div class="message-sources"></div><div class="message-provenance"></div>'}
      ${isUser ? '' : badgeBlock(opts.badge ?? '', false)}
      ${isUser ? '' : '<p class="message-meta hidden mt-1 text-[11px] text-slate-500 font-mono"></p>'}
      <div class="message-actions"></div>
    </div>`;

  const bubble = /** @type {HTMLElement} */ (msgDiv.querySelector('.message-bubble'));
  const content = /** @type {HTMLElement} */ (msgDiv.querySelector('.message-content'));
  if (opts.attachments?.length) bubble.insertBefore(attachmentChips(opts.attachments, isUser), content);
  if (!isUser) {
    linkifyCitations(content, opts.citations ?? null);
    decorateCodeBlocks(content);
    setAnswerSource(content, mainText);
    attachSources(msgDiv, opts);
    setBadgeLabel(msgDiv, opts.badge ?? '', opts.badgeParams);
    if (opts.meta) setMessageMeta(msgDiv, opts.meta);
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
  div.className = 'flex items-start gap-3 w-full max-w-4xl mx-auto';
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
 * The live details block of a streaming answer: collapsed, it says that the model is reasoning; the
 * reasoning itself is only ever shown inside it.
 */
function liveThoughtBlock() {
  return `
    <div class="thought-container live-thought mb-3 rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden">
      <button type="button" data-action="toggle-thought" aria-expanded="false" class="w-full px-3.5 py-2 flex items-center justify-between text-left text-slate-600 hover:text-slate-900 bg-slate-100/60 hover:bg-slate-100 transition select-none">
        <span class="flex items-center gap-2 text-xs font-semibold text-slate-800">
          <i data-lucide="lightbulb" class="w-3.5 h-3.5 text-amber-600"></i>
          <span data-i18n="chat.reasoning">${escapeHtml(t('chat.reasoning'))}</span>
        </span>
        <span class="flex items-center gap-2 text-[11px] text-slate-600">
          <span class="thought-status-text text-[11px] text-amber-800 font-semibold" data-i18n="trace.show">${escapeHtml(t('trace.show'))}</span>
          <i data-lucide="chevron-down" class="thought-chevron w-3.5 h-3.5 transition-transform duration-200 text-slate-600"></i>
        </span>
      </button>
      <div class="thought-body hidden p-3 border-t border-slate-200 bg-white text-[12px] text-slate-600 whitespace-pre-wrap break-words"></div>
    </div>`;
}

/**
 * A message bubble that re-renders at most once per animation frame while tokens stream in.
 * Reasoning streams into a collapsed details block, never into the answer.
 * @param {string} badgeKey i18n key of the engine label
 * @param {Record<string, string>} [badgeParams] parameters of the engine label
 * @param {{ nodeId?: string, before?: Element | null }} [placement] `before`: insert above this element instead of at the end
 */
export function createStreamingMessage(badgeKey, badgeParams, placement = {}) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message-row flex items-start gap-3 w-full max-w-4xl mx-auto';
  msgDiv.dataset.role = 'assistant';
  msgDiv.dataset.streaming = 'true';
  if (placement.nodeId) msgDiv.dataset.nodeId = placement.nodeId;
  msgDiv.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="message-bubble flex-1 min-w-0 bg-white border border-slate-200 rounded-2xl p-4 text-slate-800 text-sm leading-relaxed shadow-xs">
      <div class="streaming-trace"></div>
      <div class="message-content prose-custom break-words"><span class="stream-cursor inline-block w-1.5 h-3.5 bg-[#FFCA00] animate-pulse"></span></div>
      <div class="message-sources"></div>
      <div class="message-provenance"></div>
      ${badgeBlock(badgeKey || 'chat-thread.badge.waiting', true)}
      <p class="message-meta hidden mt-1 text-[11px] text-slate-500 font-mono"></p>
      <div class="message-actions"></div>
    </div>`;
  setBadgeLabel(msgDiv, badgeKey || 'chat-thread.badge.waiting', badgeParams);
  if (placement.before && placement.before.parentElement === container()) container().insertBefore(msgDiv, placement.before);
  else container().appendChild(msgDiv);
  scrollToBottom();

  const proseEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.message-content'));
  const traceEl = /** @type {HTMLElement} */ (msgDiv.querySelector('.streaming-trace'));
  let pending = '';
  let reasoning = '';
  let frame = 0;
  let thinkingShown = false;

  /** The live details block, created with the first reasoning. */
  const liveBody = () => {
    let body = /** @type {HTMLElement | null} */ (traceEl.querySelector('.live-thought .thought-body'));
    if (!body) {
      traceEl.innerHTML = liveThoughtBlock();
      refreshIcons(traceEl);
      body = /** @type {HTMLElement} */ (traceEl.querySelector('.live-thought .thought-body'));
    }
    return body;
  };

  /** @param {boolean} final  the whole answer: rendered even when it is reasoning only */
  const flush = (final) => {
    frame = 0;
    const view = splitStreamingText(pending);
    if (reasoning) liveBody().textContent = reasoning;
    if (view.thinking && !final) {
      // While the model reasons inside its text (<think>), one line says so instead of re-rendering text that stays hidden.
      if (!thinkingShown) {
        const note = document.createElement('span');
        note.className = 'stream-thinking';
        setText(note, 'chat.reasoning');
        proseEl.replaceChildren(note);
        thinkingShown = true;
      }
    } else {
      thinkingShown = false;
      const text = final ? splitReasoning(pending).answer || pending : view.answer;
      if (text || final) proseEl.innerHTML = renderMarkdown(text);
    }
    scrollToBottom();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => flush(false));
  };

  return {
    element: msgDiv,
    /** @param {string} text  the answer so far */
    update(text) {
      pending = text;
      schedule();
    },
    /** @param {string} text  the model's reasoning so far */
    reasoning(text) {
      reasoning = text;
      schedule();
    },
    /**
     * Names the model that answers once it is known.
     * @param {string} key
     * @param {Record<string, string>} [params]
     */
    setBadge(key, params) {
      setBadgeLabel(msgDiv, key, params);
    },
    /**
     * @param {string} finalText
     * @param {{ citations: string | null, trace: string | null, durationMs: number | null, traceRoles?: string[], reasoning?: string, meta?: string }} meta
     */
    finalize(finalText, meta) {
      if (frame) cancelAnimationFrame(frame);
      pending = finalText;
      flush(true);
      linkifyCitations(proseEl, meta.citations);
      decorateCodeBlocks(proseEl);
      const split = splitReasoning(finalText);
      setAnswerSource(proseEl, split.answer || finalText);
      const thoughts = [split.thoughts, meta.reasoning ?? reasoning].filter((x) => x?.trim()).join('\n\n');
      const fullTrace = [thoughts, meta.trace].filter(Boolean).join('\n\n');
      traceEl.innerHTML = fullTrace ? thoughtBlock(fullTrace, meta.durationMs, rolesWithReasoning(thoughts, meta.traceRoles)) : '';
      attachSources(msgDiv, { citations: meta.citations });
      if (meta.meta) setMessageMeta(msgDiv, meta.meta);
      msgDiv.querySelector('.animate-pulse')?.classList.remove('animate-pulse');
      delete msgDiv.dataset.streaming;
      refreshIcons(msgDiv);
    },
    remove() {
      if (frame) cancelAnimationFrame(frame);
      msgDiv.remove();
    },
  };
}

/**
 * @param {string} [key]  i18n key of the indicator text
 * @returns {() => void} removes the indicator
 */
export function appendLoading(key = 'chat.thinking') {
  const div = document.createElement('div');
  div.className = 'flex items-start gap-3 w-full max-w-4xl mx-auto';
  div.setAttribute('role', 'status');
  div.innerHTML = `
    ${ASSISTANT_AVATAR}
    <div class="bg-white border border-slate-200 rounded-2xl px-3.5 py-3 text-slate-800 text-xs flex items-center gap-2.5 shadow-xs">
      <span class="relative flex h-2.5 w-2.5" aria-hidden="true">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
      </span>
      <span class="font-medium text-slate-700" data-i18n="${escapeHtml(key)}">${escapeHtml(t(key))}</span>
    </div>`;
  container().appendChild(div);
  scrollToBottom();
  return () => div.remove();
}
