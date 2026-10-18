// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// The research views: the Research tab (a question box, the list of jobs with their progress and,
// for a finished job, its report), the compact list in the chat side panel, and the badge with the
// number of running jobs in the page header and on the Research entry of the navigation.
//
// Reports are read back from the store and checked again before they are shown (recheckSources,
// recheckWeb), so only sentences the gate releases appear. Citation labels become the app's citation
// buttons (rag/citations.js), the search suggestions of a web answer show only in the sandboxed
// grounding frame (render.js), and every text that comes from a model, a document or the web is
// set as text, never as markup. All labels carry their i18n keys, so a language switch relabels the
// views in place.
import { downloadText } from '../dom.js';
import { formatDate, onLocaleChange, setText, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { citationButton, registerCitations } from '../rag/citations.js';
import { receiptButton, storeReceiptDraft } from '../rag/receipts.js';
import { mountGroundingFrame } from '../render.js';
import { readLocalJson, writeLocalJson } from '../storage.js';
import { chip, html, icon, label, provenanceBadge } from '../ui/kit.js';
import { parseLabel } from '../core/labels.js';
import { researchLocale, SECTION_IDS } from './prompts.js';
import { recheckSources } from './sources-part.js';
import { recheckWeb } from './web-part.js';
import { receiptDraft, reportMarkdown, webReasonKey } from './deep.js';

/** @typedef {import('./jobs.js').ResearchJobs} ResearchJobs */
/** @typedef {import('./jobs.js').ResearchJob} ResearchJob */
/** @typedef {import('./jobs.js').JobStatus} JobStatus */
/** @typedef {import('./deep.js').SourcesPart} SourcesPart */
/** @typedef {import('./web-part.js').WebPart} WebPart */
/** @typedef {import('../features/registry.js').FeatureContext} FeatureContext */
/** @typedef {import('../ui/kit.js').Tone} Tone */

/**
 * What the views need besides the engine; tests pass their own.
 * @typedef {object} ViewDeps
 * @property {string} version  app version for receipts
 * @property {(artifactId: string) => Promise<string | null>} [loadReport]  the stored report Markdown
 * @property {(docId: string) => import('../core/receipt.js').ReceiptDocument | undefined} [documentInfo]
 * @property {(name: string, text: string, type: string) => void} [download]
 */

/** Remembered choices of the question box (this device only). */
const PREFS_KEY = 'starpi_research_prefs_v1';

/** @type {Readonly<Record<JobStatus, { tone: Tone, icon: string }>>} */
const STATUS = Object.freeze({
  queued: { tone: 'neutral', icon: 'circle-dashed' },
  running: { tone: 'info', icon: 'loader-2' },
  done: { tone: 'ok', icon: 'check-circle-2' },
  failed: { tone: 'danger', icon: 'octagon-alert' },
  cancelled: { tone: 'neutral', icon: 'x' },
  stale: { tone: 'warn', icon: 'triangle-alert' },
});

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]  set as text
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * An element whose text follows the language.
 * @param {string} tag
 * @param {string} className
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
function keyed(tag, className, key, params) {
  const node = el(tag, className);
  setText(node, key, params);
  return node;
}

/**
 * A button with an icon and a translated label.
 * @param {string} iconName
 * @param {string} key
 * @param {string} className
 */
function button(iconName, key, className) {
  const btn = /** @type {HTMLButtonElement} */ (el('button', `btn ${className}`));
  btn.type = 'button';
  const i = el('i', 'w-3.5 h-3.5');
  i.dataset.lucide = iconName;
  btn.append(i, keyed('span', '', key));
  return btn;
}

/** @param {HTMLElement} node @param {boolean} hidden */
const hide = (node, hidden) => node.classList.toggle('hidden', hidden);

/**
 * A web source's address as a URL when it is http(s), else null. new URL() rather than URL.parse,
 * which the browsers the build targets do not all have.
 * @param {unknown} uri
 * @returns {URL | null}
 */
function httpUrl(uri) {
  if (typeof uri !== 'string') return null;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The progress line of a running job.
 * @param {ResearchJob} job
 * @returns {[string, Record<string, string | number>] | null}
 */
export function progressText(job) {
  const p = job.progress;
  if (job.status !== 'running' || !p) return null;
  const step = t(`research.step.${p.step}`);
  if (p.round === 0 && p.sources === 0) return ['research.progress_short', { step }];
  return ['research.progress', { step, round: p.round, n: p.sources }];
}

/**
 * The excerpts of a sources part as citations the citation drawer opens, and their scope.
 * @param {SourcesPart} part
 */
function citationScope(part) {
  const list = part.excerpts.map((e) => ({
    label: e.label,
    doc: e.doc,
    chunk: parseLabel(e.label)?.chunk ?? 1,
    source: e.source,
    heading: e.heading,
    text: e.text,
    truncated: e.truncated,
    score: null,
    documentId: e.documentId,
    span: e.span,
  }));
  const scope = registerCitations(list);
  return { scope, index: new Map(list.map((c, i) => [c.label, i])) };
}

/**
 * Renders the report of a finished (or partly finished) job into `host`.
 * @param {HTMLElement} host
 * @param {ResearchJob} job
 * @param {ViewDeps} deps
 * @returns {() => void} removes the grounding frames
 */
export function renderReport(host, job, deps) {
  host.replaceChildren();
  /** @type {Array<() => void>} */
  const frames = [];
  const locale = researchLocale(job.locale);
  const stored = job.parts.sources;
  const sources = stored ? /** @type {SourcesPart} */ ({ ...stored, ...recheckSources(stored, { question: job.question, locale }) }) : null;
  const web = job.parts.web ? recheckWeb(job.parts.web, { locale }) : null;

  if (sources) {
    const section = el('section', 'space-y-2');
    const head = el('div', 'flex flex-wrap items-center gap-2');
    head.append(keyed('h4', 'text-sm font-semibold text-slate-950', 'research.part.sources'));
    if (sources.released > 0) {
      const clean = sources.withheld === 0 && (sources.check?.unsupported ?? 0) === 0 && (sources.check?.weak ?? 0) === 0;
      head.insertAdjacentHTML('beforeend', provenanceBadge(clean ? 'checked' : 'mixed').value);
    }
    section.append(head);
    const via = sources.via === 'quote' ? keyed('p', 'text-xs text-slate-500', 'research.via.quote') : keyed('p', 'text-xs text-slate-500', `research.via.${sources.via}`, { model: sources.provider?.model ?? '' });
    section.append(via);
    if (sources.fallback) section.append(keyed('p', 'text-xs text-amber-900', 'research.fallback', { code: sources.fallback }));
    const { scope, index } = citationScope(sources);
    /** @param {import('./sources-part.js').KeptSentence} s */
    const sentence = (s) => {
      const frag = document.createDocumentFragment();
      frag.append(s.text);
      for (const c of s.cites) {
        const i = index.get(c);
        if (scope && i !== undefined) frag.append(' ', citationButton(scope, i, 'inline'));
      }
      return frag;
    };
    let any = false;
    for (const id of SECTION_IDS) {
      const list = sources.sections[id] ?? [];
      if (!list.length) continue;
      any = true;
      section.append(keyed('h5', 'pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500', `research.section.${id}`));
      if (id === 'summary') {
        const p = el('p', 'text-sm leading-relaxed text-slate-800');
        list.forEach((s, i) => {
          if (i) p.append(' ');
          p.append(sentence(s));
        });
        section.append(p);
      } else {
        const ul = el('ul', 'list-disc pl-5 space-y-1 text-sm leading-relaxed text-slate-800');
        for (const s of list) {
          const li = el('li');
          li.append(sentence(s));
          ul.append(li);
        }
        section.append(ul);
      }
    }
    if (!any) section.append(keyed('p', 'text-sm text-slate-600', 'research.no_answer'));
    const counts = el('p', 'text-xs text-slate-500');
    counts.append(keyed('span', '', 'research.gate_counts', { released: sources.released, withheld: sources.withheld }));
    if (sources.check) counts.append(' · ', keyed('span', '', 'research.check_counts', { ...sources.check }));
    section.append(counts);
    const cited = sources.excerpts.filter((e) => sources.cited.includes(e.label));
    if (cited.length && scope) {
      section.append(keyed('h5', 'pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500', 'research.doc_sources'));
      const row = el('div', 'flex flex-wrap gap-1.5');
      for (const e of cited) {
        const i = index.get(e.label);
        if (i !== undefined) row.append(citationButton(scope, i, 'badge'));
      }
      section.append(row);
    }
    host.append(section);
  }

  if (web) {
    const section = el('section', 'space-y-2 pt-3 border-t border-slate-100');
    const head = el('div', 'flex flex-wrap items-center gap-2');
    head.append(keyed('h4', 'text-sm font-semibold text-slate-950', 'research.part.web'));
    if (web.status === 'done') head.insertAdjacentHTML('beforeend', provenanceBadge('web').value);
    if (web.status === 'withheld') head.insertAdjacentHTML('beforeend', provenanceBadge('withheld').value);
    section.append(head);
    if (web.query) section.append(keyed('p', 'text-xs text-slate-500 break-words', 'research.web_query', { query: web.query }));
    if (web.removed?.length) section.append(keyed('p', 'text-xs text-slate-500', 'research.web_removed', { kinds: web.removed.map((k) => t(`research.pii.${k}`)).join(', ') }));
    if (web.status === 'done' && web.text) {
      for (const para of web.text.split(/\n{2,}/)) if (para.trim()) section.append(el('p', 'text-sm leading-relaxed text-slate-800 whitespace-pre-line break-words', para.trim()));
      section.append(keyed('p', 'text-xs text-emerald-800', 'research.web_released'));
      for (const suggestions of web.suggestionsHtml ?? []) {
        const frameHost = el('div', 'mt-1');
        section.append(frameHost);
        frames.push(mountGroundingFrame(frameHost, suggestions, { title: t('research.suggestions') }));
      }
    } else if (web.status === 'withheld') {
      section.append(keyed('p', 'text-sm text-slate-700', 'research.web_withheld', { reason: t(`research.web_reason.${webReasonKey(web.reason)}`) }));
    } else if (web.status === 'off') {
      section.append(keyed('p', 'text-sm text-slate-700', web.reason === 'empty_query' ? 'research.web_empty' : 'research.web_off'));
    } else if (web.status === 'running') {
      section.append(keyed('p', 'text-sm text-slate-700', 'research.web_running'));
    } else {
      section.append(keyed('p', 'text-sm text-slate-700', 'research.web_failed', { code: web.reason ?? 'error' }));
    }
    if (web.sources.length) {
      section.append(keyed('h5', 'pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500', 'research.web_sources'));
      const ul = el('ul', 'space-y-1 text-xs');
      for (const s of web.sources) {
        const url = httpUrl(s.uri);
        if (!url) continue;
        const li = el('li', 'break-words');
        const a = /** @type {HTMLAnchorElement} */ (el('a', 'text-sky-800 underline hover:text-sky-950', s.title || url.hostname));
        a.href = url.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a, el('span', 'text-slate-500', ` · ${url.hostname}`));
        ul.append(li);
      }
      section.append(ul);
    }
    host.append(section);
  }

  if (sources && job.status === 'done') {
    const actions = el('div', 'flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100');
    const md = button('download', 'research.actions.export_md', 'btn-secondary');
    md.dataset.role = 'export';
    md.addEventListener('click', async () => {
      const text = (job.artifactId ? await deps.loadReport?.(job.artifactId) : null) ?? reportMarkdown({ question: job.question, createdAt: job.createdAt, locale, sources, web });
      (deps.download ?? downloadText)(`starpi-research-${job.id.slice(0, 10)}.md`, text, 'text/markdown');
    });
    actions.append(md);
    if (sources.excerpts.length) {
      const draft = receiptDraft({ question: job.question, createdAt: job.createdAt, locale, sources }, { version: deps.version, documentInfo: deps.documentInfo });
      const receipt = receiptButton(storeReceiptDraft(draft));
      receipt.classList.remove('mt-2');
      actions.append(receipt);
    }
    host.append(actions);
  }
  refreshIcons(host);
  return () => {
    for (const destroy of frames) destroy();
  };
}

/**
 * @typedef {object} JobCard
 * @property {HTMLLIElement} root
 * @property {HTMLElement} question
 * @property {HTMLElement} meta
 * @property {HTMLElement} chips
 * @property {HTMLElement} progress
 * @property {HTMLElement} hint
 * @property {HTMLButtonElement} open
 * @property {HTMLButtonElement} cancel
 * @property {HTMLButtonElement} retry
 * @property {HTMLButtonElement} remove
 * @property {HTMLElement} report
 * @property {string} shown        the state the report shows ('' while closed)
 * @property {() => void} cleanup
 */

/**
 * Mounts the Research tab.
 * @param {HTMLElement} root
 * @param {ResearchJobs} jobs
 * @param {ViewDeps} deps
 */
export function mountResearchView(root, jobs, deps) {
  const prefs = readLocalJson(PREFS_KEY, { web: false, stripPii: true });
  root.innerHTML = html`<div class="max-w-3xl mx-auto w-full space-y-5" data-research-view>
    <div>
      ${label('research.title', { tag: 'h2', className: 'section-title' })}
      ${label('research.intro', { tag: 'p', className: 'section-subtitle max-w-2xl' })}
    </div>
    <form id="researchForm" class="card p-4 space-y-3" novalidate>
      <label for="researchQuestion" class="field-label" data-i18n="research.question_label">${t('research.question_label')}</label>
      <textarea id="researchQuestion" class="field min-h-[5.5rem]" rows="3" maxlength="2000" data-i18n-placeholder="research.question_placeholder" placeholder="${t('research.question_placeholder')}"></textarea>
      <p id="researchFocus" class="hidden text-xs text-slate-700 flex flex-wrap items-center gap-2"><span id="researchFocusText"></span><button type="button" id="researchFocusClear" class="btn btn-ghost px-2 py-1">${label('research.focus_clear')}</button></p>
      <div class="flex flex-col gap-2 text-sm text-slate-800">
        <label class="inline-flex items-start gap-2"><input type="checkbox" id="researchWeb" class="mt-0.5"${prefs.web ? ' checked' : ''}>${label('research.include_web')}</label>
        <label class="inline-flex items-start gap-2"><input type="checkbox" id="researchStripPii" class="mt-0.5"${prefs.stripPii !== false ? ' checked' : ''}>${label('research.strip_pii')}</label>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button type="submit" id="researchStart" class="btn btn-primary">${icon('telescope', 'w-3.5 h-3.5')}${label('research.start')}</button>
        <p id="researchFormStatus" class="text-xs text-slate-600" role="status"></p>
      </div>
    </form>
    <section aria-labelledby="researchJobsTitle" class="space-y-3">
      ${label('research.jobs_title', { tag: 'h3', id: 'researchJobsTitle', className: 'text-sm font-semibold text-slate-900' })}
      <p id="researchEmpty" class="empty-state">${icon('inbox', '')}${label('research.empty')}</p>
      <ol id="researchJobList" class="space-y-3"></ol>
    </section>
  </div>`.value;
  // The checkbox inputs carry their state in the markup above; html`` escapes values, the
  // attribute strings are fixed.
  refreshIcons(root);

  const form = /** @type {HTMLFormElement} */ (root.querySelector('#researchForm'));
  const question = /** @type {HTMLTextAreaElement} */ (root.querySelector('#researchQuestion'));
  const webBox = /** @type {HTMLInputElement} */ (root.querySelector('#researchWeb'));
  const piiBox = /** @type {HTMLInputElement} */ (root.querySelector('#researchStripPii'));
  const status = /** @type {HTMLElement} */ (root.querySelector('#researchFormStatus'));
  const focusRow = /** @type {HTMLElement} */ (root.querySelector('#researchFocus'));
  const focusText = /** @type {HTMLElement} */ (root.querySelector('#researchFocusText'));
  const list = /** @type {HTMLOListElement} */ (root.querySelector('#researchJobList'));
  const empty = /** @type {HTMLElement} */ (root.querySelector('#researchEmpty'));
  /** @type {{ focus: string | null, origin: import('./jobs.js').JobOrigin }} */
  const pending = { focus: null, origin: 'header' };
  /** @type {Map<string, JobCard>} */
  const cards = new Map();
  /** @type {Set<string>} */
  const opened = new Set();

  const savePrefs = () => writeLocalJson(PREFS_KEY, { web: webBox.checked, stripPii: piiBox.checked });
  webBox.addEventListener('change', savePrefs);
  piiBox.addEventListener('change', savePrefs);

  /** @param {string | null} focus */
  const setFocus = (focus) => {
    pending.focus = focus;
    hide(focusRow, !focus);
    if (focus) setText(focusText, 'research.focus', { doc: focus });
  };
  root.querySelector('#researchFocusClear')?.addEventListener('click', () => {
    setFocus(null);
    pending.origin = 'header';
    question.focus();
  });

  async function submit() {
    const text = question.value.trim();
    if (!text) {
      setText(status, 'research.question_required');
      question.focus();
      return;
    }
    try {
      const id = await jobs.start({ question: text, origin: pending.origin, scope: { focus: pending.focus }, options: { web: webBox.checked, stripPii: piiBox.checked } });
      question.value = '';
      setFocus(null);
      pending.origin = 'header';
      setText(status, 'research.started');
      opened.add(id);
      render();
    } catch (err) {
      console.warn('[starpi] research could not start', err);
      setText(status, 'research.start_failed');
    }
  }
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  question.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void submit();
    }
  });

  /**
   * @param {ResearchJob} job
   * @returns {JobCard}
   */
  function createCard(job) {
    const li = /** @type {HTMLLIElement} */ (el('li', 'card p-4 space-y-3'));
    li.dataset.job = job.id;
    const top = el('div', 'flex items-start justify-between gap-3');
    const text = el('div', 'min-w-0 space-y-0.5');
    const q = el('p', 'text-sm font-semibold text-slate-950 break-words');
    const meta = el('p', 'text-xs text-slate-500');
    text.append(q, meta);
    const chips = el('div', 'flex flex-wrap items-center justify-end gap-1.5 flex-shrink-0');
    top.append(text, chips);
    const progress = el('p', 'text-xs text-slate-700');
    progress.setAttribute('role', 'status');
    const hint = el('p', 'text-xs text-slate-600');
    const actions = el('div', 'flex flex-wrap gap-2');
    const open = button('file-text', 'research.actions.open', 'btn-secondary');
    const cancel = button('x', 'research.actions.cancel', 'btn-ghost');
    const retry = button('refresh-cw', 'research.actions.retry', 'btn-secondary');
    const remove = button('trash-2', 'research.actions.remove', 'btn-ghost');
    open.dataset.role = 'open';
    cancel.dataset.role = 'cancel';
    retry.dataset.role = 'retry';
    remove.dataset.role = 'remove';
    actions.append(open, cancel, retry, remove);
    const report = el('div', 'hidden space-y-4 border-t border-slate-100 pt-3');
    report.id = `researchReport-${job.id}`;
    open.setAttribute('aria-controls', report.id);
    li.append(top, progress, hint, actions, report);
    /** @type {JobCard} */
    const card = { root: li, question: q, meta, chips, progress, hint, open, cancel, retry, remove, report, shown: '', cleanup: () => {} };
    open.addEventListener('click', () => {
      if (opened.has(job.id)) opened.delete(job.id);
      else {
        opened.add(job.id);
        void jobs.markRead(job.id);
      }
      const current = jobs.get(job.id);
      if (current) update(card, current);
    });
    cancel.addEventListener('click', () => void jobs.cancel(job.id));
    retry.addEventListener('click', () => void jobs.retry(job.id));
    remove.addEventListener('click', () => {
      // Focus moves to the next card (or the question box) before this one goes.
      const next = /** @type {HTMLElement | null} */ (li.nextElementSibling ?? li.previousElementSibling);
      (next?.querySelector('button') ?? question).focus();
      void jobs.remove(job.id);
    });
    return card;
  }

  /**
   * @param {JobCard} card
   * @param {ResearchJob} job
   */
  function update(card, job) {
    card.question.textContent = job.question;
    setText(card.meta, 'research.meta', { date: formatDate(new Date(job.createdAt), { dateStyle: 'medium', timeStyle: 'short' }), origin: t(`research.origin.${job.origin}`) });
    const def = STATUS[job.status] ?? STATUS.queued;
    card.chips.innerHTML = html`${job.unread ? html`<span class="badge badge-brand">${label('research.unread')}</span>` : ''}${chip({ label: `research.status.${job.status}`, tone: def.tone, icon: def.icon })}`.value;
    const p = progressText(job);
    if (p) setText(card.progress, ...p);
    else card.progress.textContent = '';
    hide(card.progress, !p);
    const elsewhere = job.status === 'running' && !jobs.isRunner();
    const hintKey = job.status === 'stale' ? 'research.stale_hint' : job.status === 'failed' ? 'research.failed_hint' : job.status === 'queued' ? 'research.queued_hint' : elsewhere ? 'research.elsewhere' : null;
    if (hintKey) setText(card.hint, hintKey, { code: job.error ?? 'error' });
    else card.hint.textContent = '';
    hide(card.hint, !hintKey);
    const hasReport = Boolean(job.parts.sources || job.parts.web);
    hide(card.open, !hasReport);
    hide(card.cancel, job.status !== 'queued' && job.status !== 'running');
    hide(card.retry, job.status !== 'stale' && job.status !== 'failed' && job.status !== 'cancelled');
    const isOpen = hasReport && opened.has(job.id);
    card.open.setAttribute('aria-expanded', String(isOpen));
    setText(/** @type {HTMLElement} */ (card.open.querySelector('span')), isOpen ? 'research.actions.close' : 'research.actions.open');
    hide(card.report, !isOpen);
    const state = isOpen ? `${job.status}:${job.updatedAt}` : '';
    if (state !== card.shown) {
      card.cleanup();
      card.cleanup = () => {};
      card.shown = state;
      if (isOpen) card.cleanup = renderReport(card.report, job, deps);
      else card.report.replaceChildren();
    }
    refreshIcons(card.root);
  }

  function render() {
    const all = jobs.list();
    hide(empty, all.length > 0);
    const ids = new Set(all.map((j) => j.id));
    for (const [id, card] of cards) {
      if (ids.has(id)) continue;
      card.cleanup();
      card.root.remove();
      cards.delete(id);
      opened.delete(id);
    }
    all.forEach((job, i) => {
      let card = cards.get(job.id);
      if (!card) {
        card = createCard(job);
        cards.set(job.id, card);
      }
      if (list.children[i] !== card.root) list.insertBefore(card.root, list.children[i] ?? null);
      update(card, job);
    });
  }

  jobs.onChange((change) => {
    if (change.type === 'remove' || change.type === 'start' || change.type === 'sync' || change.type === 'runner') return render();
    const job = change.id ? jobs.get(change.id) : null;
    const card = job ? cards.get(job.id) : null;
    if (job && card) update(card, job);
    else render();
  });
  onLocaleChange(() => {
    for (const [id, card] of cards) {
      const job = jobs.get(id);
      if (!job) continue;
      card.shown = '';
      update(card, job);
    }
  });
  void jobs.ready.then(render);
  render();

  return {
    /**
     * Puts a question into the box ("Research this"), with the document it is about.
     * @param {string} text
     * @param {{ focus?: string | null, origin?: import('./jobs.js').JobOrigin }} [options]
     */
    prefill(text, options = {}) {
      question.value = text.slice(0, 2000);
      setFocus(options.focus ?? null);
      pending.origin = options.origin ?? 'header';
      setText(status, 'research.prefilled');
      question.focus();
    },
    /**
     * Opens the report of a job and scrolls it into view.
     * @param {string} id
     */
    openJob(id) {
      opened.add(id);
      void jobs.markRead(id);
      render();
      cards.get(id)?.root.scrollIntoView({ block: 'nearest' });
    },
  };
}

/** @typedef {ReturnType<typeof mountResearchView>} ResearchView */

/**
 * Mounts the research list of the chat side panel: the jobs started from a chat, newest first. It
 * stays empty (the panel then shows its own note) until there is one.
 * @param {HTMLElement} root
 * @param {Pick<FeatureContext, 'switchTab'>} ctx
 * @param {ResearchJobs} jobs
 * @param {{ show: (id: string) => void }} view
 */
export function mountResearchAside(root, ctx, jobs, view) {
  function render() {
    const mine = jobs.list().filter((j) => j.origin === 'chat').slice(0, 6);
    if (!mine.length) {
      root.replaceChildren();
      return;
    }
    const ol = el('ol', 'space-y-2');
    ol.setAttribute('aria-label', t('research.jobs_title'));
    ol.setAttribute('data-i18n-aria', 'research.jobs_title');
    for (const job of mine) {
      const li = el('li', 'card p-3 space-y-1.5');
      li.append(el('p', 'text-sm font-medium text-slate-900 break-words line-clamp-3', job.question));
      const def = STATUS[job.status] ?? STATUS.queued;
      const row = el('div', 'flex flex-wrap items-center gap-2');
      row.insertAdjacentHTML('beforeend', chip({ label: `research.status.${job.status}`, tone: def.tone, icon: def.icon }).value);
      const p = progressText(job);
      if (p) row.append(keyed('span', 'text-xs text-slate-600', ...p));
      li.append(row);
      const show = button('telescope', 'research.actions.show', 'btn-ghost px-2 py-1');
      show.addEventListener('click', () => {
        ctx.switchTab('research');
        view.show(job.id);
      });
      li.append(show);
      ol.append(li);
    }
    root.replaceChildren(ol);
    refreshIcons(root);
  }
  jobs.onChange(render);
  onLocaleChange(render);
  void jobs.ready.then(render);
  render();
}

/**
 * The badge with the number of running jobs: a button in the page header (next to the language
 * switch) that opens the Research tab, and a count on the Research entry of the navigation. Both
 * are hidden while nothing runs.
 * @param {Pick<FeatureContext, 'switchTab'>} ctx
 * @param {ResearchJobs} jobs
 * @param {{ getElementById(id: string): HTMLElement | null }} [doc]
 */
export function mountResearchBadge(ctx, jobs, doc = document) {
  const anchor = doc.getElementById('langSwitch');
  /** @type {HTMLButtonElement | null} */
  let badge = null;
  if (anchor?.parentElement) {
    badge = /** @type {HTMLButtonElement} */ (el('button', 'hidden btn btn-ghost px-2 py-1 text-amber-950 bg-amber-50 border border-amber-200'));
    badge.type = 'button';
    badge.id = 'researchBadge';
    const i = el('i', 'w-3.5 h-3.5');
    i.dataset.lucide = 'telescope';
    badge.append(i, el('span', 'tabular-nums'));
    badge.addEventListener('click', () => ctx.switchTab('research'));
    anchor.parentElement.insertBefore(badge, anchor);
    refreshIcons(badge);
  }
  const nav = doc.getElementById('nav-research');
  /** @type {HTMLElement | null} */
  let count = null;
  if (nav) {
    count = el('span', 'hidden rail-hide ml-auto badge badge-brand tabular-nums');
    count.setAttribute('aria-hidden', 'true');
    nav.append(count);
  }
  function render() {
    const n = jobs.running();
    if (badge) {
      hide(badge, n === 0);
      /** @type {HTMLElement} */ (badge.querySelector('span')).textContent = String(n);
      badge.setAttribute('aria-label', t('research.badge', { n }));
      badge.setAttribute('data-i18n-aria', 'research.badge');
      badge.setAttribute('data-i18n-params', JSON.stringify({ n }));
      badge.title = t('research.badge', { n });
    }
    if (count) {
      hide(count, n === 0);
      count.textContent = String(n);
    }
  }
  jobs.onChange(render);
  onLocaleChange(render);
  void jobs.ready.then(render);
  render();
}
