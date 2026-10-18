// @ts-check
// Research jobs: the Research tab, the research list of the chat side panel and the header badge
// with the running jobs (research/view.js), over one job engine per tab (research/jobs.js) that
// runs the pipeline of research/deep.js in the background. The engine, its views and the pipeline
// load as their own chunk after the first paint.
//
// Entry points for the rest of the app:
//   - startResearch({ question, origin, scope, options }) starts a job and resolves its id; the chat
//     calls it for "Research this" on an answer (origin 'chat', scope { conversationId, nodeId });
//   - prefillResearch(question, { focus, origin }) opens the Research tab with the question in its
//     box, for the person to adjust and start;
//   - a button with data-action="research-this" does either: data-question (required), data-focus
//     (a document the question is about), data-origin ('chat' | 'library'), data-conversation and
//     data-node (the chat turn it belongs to) and data-start="1" to start at once instead of
//     prefilling. A button inside an open dialog closes it first.
//   - onResearchChange(fn) reports every change of the job list.
import { APP_VERSION } from '../config.js';
import { getLocale } from '../i18n/index.js';
import { registerFeature } from './registry.js';

/** @typedef {import('../research/jobs.js').ResearchJobs} ResearchJobs */
/** @typedef {import('../research/jobs.js').StartRequest} StartRequest */
/** @typedef {import('../research/jobs.js').JobChange} JobChange */
/** @typedef {import('../research/view.js').ResearchView} ResearchView */
/** @typedef {import('./registry.js').FeatureContext} FeatureContext */

/** @type {Promise<ResearchJobs> | null} */
let engine = null;
/** @type {ResearchView | null} */
let view = null;
/** @type {FeatureContext | null} */
let shell = null;

/**
 * The job engine of this tab, created on first use.
 * @returns {Promise<ResearchJobs>}
 */
export function researchJobs() {
  engine ??= (async () => {
    const [{ CHANNEL_NAME, createResearchJobs, idbJobStore }, { runResearch }, { browserRuntime }, { appDb }] = await Promise.all([
      import('../research/jobs.js'),
      import('../research/deep.js'),
      import('../research/runtime.js'),
      import('../store/schema.js'),
    ]);
    const runtime = browserRuntime();
    const nav = /** @type {Navigator & { locks?: import('../research/jobs.js').LockManagerLike }} */ (globalThis.navigator);
    const jobs = createResearchJobs({
      store: idbJobStore(appDb),
      run: (job, ctx) => runResearch(job, runtime, ctx),
      locks: nav?.locks ?? null,
      channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null,
      locale: getLocale,
    });
    // A page kept in the back-forward cache comes back with its engine; any other leaves for good.
    globalThis.addEventListener?.('pagehide', (ev) => {
      if (!(/** @type {PageTransitionEvent} */ (ev).persisted)) jobs.dispose();
    });
    return jobs;
  })();
  return engine;
}

/**
 * Starts a research job; resolves its id.
 * @param {StartRequest} request
 */
export async function startResearch(request) {
  return (await researchJobs()).start(request);
}

/**
 * Opens the Research tab with a question in its box.
 * @param {string} question
 * @param {{ focus?: string | null, origin?: 'chat' | 'library' | 'header' }} [options]
 */
export async function prefillResearch(question, options = {}) {
  await researchJobs();
  shell?.switchTab('research');
  view?.prefill(question, options);
}

/**
 * @param {(change: JobChange) => void} fn
 * @returns {Promise<() => void>}
 */
export async function onResearchChange(fn) {
  return (await researchJobs()).onChange(fn);
}

/**
 * "Research this" on a button (data-question, data-focus, data-origin, data-start).
 * @param {HTMLElement} btn
 */
async function researchThis(btn) {
  const question = (btn.dataset.question ?? '').trim();
  if (!question) return;
  const origin = btn.dataset.origin === 'chat' || btn.dataset.origin === 'library' ? btn.dataset.origin : 'header';
  const focus = btn.dataset.focus?.trim() || null;
  const dialog = /** @type {HTMLElement | null} */ (btn.closest('[role="dialog"]'));
  if (dialog) shell?.closeDialog(dialog);
  if (btn.dataset.start === '1') {
    const id = await startResearch({ question, origin, scope: { focus, conversationId: btn.dataset.conversation || null, nodeId: btn.dataset.node || null } });
    if (origin === 'chat') shell?.openChatAside('research');
    else {
      shell?.switchTab('research');
      view?.openJob(id);
    }
    return;
  }
  await prefillResearch(question, { focus, origin });
}

/** @type {import('./registry.js').Feature} */
const tab = {
  id: 'research',
  async mount(el, ctx) {
    shell = ctx;
    ctx.onAction('research-this', (btn) => void researchThis(btn));
    const [jobs, { mountResearchBadge, mountResearchView }, { documentInfo, loadReport }] = await Promise.all([researchJobs(), import('../research/view.js'), import('../research/runtime.js')]);
    view = mountResearchView(el, jobs, { version: APP_VERSION, loadReport, documentInfo });
    mountResearchBadge(ctx, jobs);
  },
};

/** @type {import('./registry.js').Feature} */
const aside = {
  id: 'research',
  async mount(el, ctx) {
    const [jobs, { mountResearchAside }] = await Promise.all([researchJobs(), import('../research/view.js')]);
    mountResearchAside(el, ctx, jobs, { show: (id) => view?.openJob(id) });
  },
};

registerFeature('tab-research', tab);
registerFeature('chat-aside-research', aside);
