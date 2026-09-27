// @ts-check
// Sample files for a first look without any setup: a small fictitious project (plan, risk register,
// kickoff notes) in the active language, read into the on-device workspace like a dropped file. The
// files are same-origin static assets; nothing is uploaded.
import { LIMITS } from './config.js';
import { onAction } from './dom.js';
import { refreshIcons } from './icons.js';
import { getLocale, setText, t } from './i18n/index.js';
import { appendMessage, appendNotice } from './messages.js';
import { registerCitations } from './rag/citations.js';
import { applyGrounding } from './rag/grounding-view.js';
import { addToWorkspace, listWorkspace, searchWorkspace } from './rag/workspace.js';
import { escapeMarkdown } from './render.js';
import { assignCitations, workspaceHit } from './retrieval.js';
import { switchTab } from './ui.js';

/** Sample files per language, under /samples/. */
export const SAMPLES = Object.freeze({
  en: ['en/nebula-plan.md', 'en/nebula-risks.csv', 'en/nebula-kickoff.pdf'],
  de: ['de/nebula-projektplan.md', 'de/nebula-risiken.csv', 'de/nebula-kickoff.pdf'],
});

/** Suggested questions about the samples (i18n keys; `<key>_question` holds the question). */
export const SAMPLE_QUESTIONS = Object.freeze(['demo.q_launch', 'demo.q_budget', 'demo.q_risks']);

const TYPES = /** @type {Record<string, string>} */ ({ md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf' });
const ICONS = ['calendar', 'wallet', 'triangle-alert'];

let loading = false;

/** @param {HTMLElement} notice */
function addQuestions(notice) {
  const row = document.createElement('div');
  row.className = 'mt-2.5 flex flex-wrap gap-2';
  SAMPLE_QUESTIONS.forEach((key, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary text-left';
    btn.dataset.action = 'quick-prompt';
    btn.dataset.arg = `${key}_question`;
    btn.dataset.scope = 'workspace'; // about the sample files: the knowledge base is not searched
    const icon = document.createElement('i');
    icon.dataset.lucide = ICONS[i];
    icon.className = 'w-3.5 h-3.5 text-amber-600';
    const label = document.createElement('span');
    setText(label, key);
    btn.append(icon, label);
    row.append(btn);
  });
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn btn-secondary text-left';
  check.dataset.action = 'demo-check';
  const checkIcon = document.createElement('i');
  checkIcon.dataset.lucide = 'shield-alert';
  checkIcon.className = 'w-3.5 h-3.5 text-rose-600';
  const checkLabel = document.createElement('span');
  setText(checkLabel, 'demo.check');
  check.append(checkIcon, checkLabel);
  row.append(check);
  notice.querySelector('.notice-body')?.after(row);
  refreshIcons(row);
}

/**
 * Shows the source check on an answer with one deliberate error. The answer is a fixed text written
 * for this demo, not generated, and says so; its citations point at the real sample chunks.
 */
async function showCheckDemo() {
  // The sample set in the workspace decides the language of the example, which may differ from the
  // interface language after a switch.
  const present = new Set(listWorkspace().map((d) => d.name));
  const order = /** @type {Array<'en' | 'de'>} */ (getLocale() === 'de' ? ['de', 'en'] : ['en', 'de']);
  const lang = order.find((l) => SAMPLES[l].every((p) => present.has(p.split('/').pop() ?? ''))) ?? order[0];
  const set = SAMPLES[lang];
  const names = new Set(set.map((p) => p.split('/').pop()));
  const find = async (/** @type {string} */ key) => (await searchWorkspace(t(key, undefined, lang), 5)).find((h) => names.has(h.docName));
  const hits = [await find('demo.flawed_find_budget'), await find('demo.flawed_find_meeting'), await find('demo.flawed_find_launch')];
  if (hits.some((h) => !h)) {
    appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'demo.check_missing' });
    return;
  }
  const unique = [...new Map(hits.map((h) => [`${h?.docId}:${h?.chunkIndex}`, workspaceHit(/** @type {import('./rag/workspace.js').WorkspaceHit} */ (h))])).values()];
  const citations = assignCitations(unique, { excerptChars: LIMITS.excerptChars });
  const scope = registerCitations(citations);
  if (!scope) return;
  const labelOf = (/** @type {number} */ i) => {
    const h = /** @type {import('./rag/workspace.js').WorkspaceHit} */ (hits[i]);
    const c = citations.find((x) => x.span?.docId === h.docId && x.span.chunkIndex === h.chunkIndex);
    return escapeMarkdown(c?.label ?? '');
  };
  appendMessage('user', t('demo.check'));
  const el = appendMessage('assistant', t('demo.flawed_answer', { budget: labelOf(0), meeting: labelOf(1), launch: labelOf(2) }, lang), {
    citations: scope,
    badge: 'demo.flawed_badge',
  });
  applyGrounding(el, { scope, sources: citations.map((c) => ({ label: c.label, doc: c.doc, heading: c.heading, text: c.text, delivered: 'full' })) });
}

/** Loads the sample set for the active language into the workspace (files already there are kept). */
export async function loadSamples() {
  if (loading) return;
  loading = true;
  switchTab('chat');
  const set = SAMPLES[getLocale() === 'de' ? 'de' : 'en'];
  const names = set.map((p) => /** @type {string} */ (p.split('/').pop()));
  const notice = appendNotice({ icon: 'folder-open', tone: 'info', title: 'demo.loading', body: 'demo.loading_body' });
  const title = /** @type {HTMLElement | null} */ (notice.querySelector('.notice-title'));
  const body = /** @type {HTMLElement | null} */ (notice.querySelector('.notice-body'));
  try {
    const present = new Set(listWorkspace().map((d) => d.name));
    for (const [i, path] of set.entries()) {
      const name = names[i];
      if (present.has(name)) continue;
      const res = await fetch(`/samples/${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await addToWorkspace(new File([blob], name, { type: TYPES[name.split('.').pop() ?? ''] ?? 'text/plain' }));
    }
    setText(title, 'demo.loaded_title');
    setText(body, 'demo.loaded_body', { names: names.join(', ') });
    addQuestions(notice);
  } catch (err) {
    setText(title, 'demo.error_title');
    setText(body, 'demo.error_body', { reason: err instanceof Error ? err.message : String(err) });
  } finally {
    loading = false;
  }
}

export function initDemo() {
  onAction('load-samples', () => loadSamples());
  onAction('demo-check', () => showCheckDemo());
}
