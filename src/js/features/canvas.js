// @ts-check
// Canvas, compare and council: the document view of the chat side panel (chat/canvas.js, tab
// Canvas), the side-by-side answers of several models (chat/compare.js, tab Compare) and the council
// in the conversation (chat/council-view.js).
//
// Entry points:
//   - "Open in canvas" on a code block (code-blocks.js OPEN_CANVAS_EVENT, taken here; enableCanvas()
//     makes the blocks offer it from now on);
//   - "Compare models" and "Ask the council" in the action bar of an answer (chat/hooks.js
//     registerMessageAction: the answer's question) and in the composer's tools menu (the text in the
//     message box);
//   - the Compare tab itself (a question typed there).
// The modules load on first use, so none of them weighs on the first paint. Answers that a
// comparison or a council chose carry a note saying so (an answer decorator).
import { enableCanvas, OPEN_CANVAS_EVENT } from '../code-blocks.js';
import { registerAnswerDecorator, registerComposerTool, registerMessageAction } from '../chat/hooks.js';
import { onChatAsideChange } from '../ui.js';
import { registerFeature } from './registry.js';

/** @typedef {import('./registry.js').FeatureContext} FeatureContext */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */

/** @type {Promise<typeof import('../chat/canvas.js')> | null} */
let canvasLoad = null;
/** @type {Promise<typeof import('../chat/compare.js')> | null} */
let compareLoad = null;
/** @type {Promise<typeof import('../chat/council-view.js')> | null} */
let councilLoad = null;
/** @type {{ canvas: HTMLElement | null, compare: HTMLElement | null }} */
const mounts = { canvas: null, compare: null };
/** @type {FeatureContext | null} */
let shell = null;

/** The canvas module, mounted into its panel on first use. */
function canvas() {
  canvasLoad ??= import('../chat/canvas.js').then((m) => {
    if (mounts.canvas) m.mountCanvas(mounts.canvas, { openAside: (tab) => shell?.openChatAside(tab) });
    return m;
  });
  return canvasLoad;
}

/** The comparison module, mounted into its panel on first use. */
function compare() {
  compareLoad ??= import('../chat/compare.js').then((m) => {
    if (mounts.compare) m.mountCompare(mounts.compare, { openAside: (tab) => shell?.openChatAside(tab) });
    return m;
  });
  return compareLoad;
}

/** The council module. */
function council() {
  councilLoad ??= import('../chat/council-view.js').then((m) => {
    m.initCouncilView();
    return m;
  });
  return councilLoad;
}

/**
 * The question an answer belongs to, as text (null for a "Continue" turn or an unknown one).
 * @param {NodeRecord} answer
 */
async function questionOf(answer) {
  if (!answer.parentId) return null;
  const { threadNode } = await import('../chat/thread.js');
  const question = threadNode(answer.parentId);
  if (!question || question.role !== 'user' || (/** @type {Record<string, unknown>} */ (question.meta ?? {})).continue) return null;
  return question;
}

/**
 * The picker value of the model that wrote an answer (to put it first in a comparison).
 * @param {NodeRecord} answer
 */
function pickerValueOf(answer) {
  const requested = (/** @type {Record<string, unknown>} */ (answer.meta ?? {})).requested;
  if (answer.provider === 'webgpu' || answer.provider === 'wasm') return 'device';
  return answer.provider && typeof requested === 'string' && requested ? `${answer.provider}:${requested}` : undefined;
}

/**
 * The text of the message box, taken out of it (the composer's tools).
 * @returns {string}
 */
function takeComposerText() {
  const input = document.getElementById('chatInput');
  if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) return '';
  const text = input.value.trim();
  if (text) {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return text;
}

/**
 * The model name a rendered answer shows in its badge (a version's author in the canvas).
 * @param {Element | null} row
 */
function badgeOf(row) {
  return row?.querySelector('.engine-badge-label')?.textContent?.trim() || undefined;
}

/** @type {import('./registry.js').Feature} */
const canvasFeature = {
  id: 'canvas',
  mount(el, ctx) {
    shell = ctx;
    mounts.canvas = el;
    // "Open in canvas" is taken here: the event is cancelled at once (the code block learns that
    // someone opened it), the canvas loads after.
    document.addEventListener(OPEN_CANVAS_EVENT, (event) => {
      const detail = /** @type {CustomEvent<{ code: string, language: string, title: string }>} */ (event).detail;
      if (!detail || typeof detail.code !== 'string') return;
      event.preventDefault();
      const source = event.target instanceof Element ? event.target : null;
      const row = source?.closest('.message-row') ?? null;
      const nodeId = row instanceof HTMLElement && row.dataset.role === 'assistant' ? (row.dataset.nodeId ?? '') : '';
      // A block of an answer that stays on this device (a compare column says so; a stored answer
      // tells the canvas itself) makes a document that stays too.
      const localOnly = Boolean(source?.closest('[data-stays-on-device]'));
      void canvas()
        .then((m) => m.openInCanvas({ ...detail, nodeId, model: badgeOf(row), ...(localOnly ? { localOnly } : {}) }))
        .catch((err) => console.warn('[starpi] the canvas could not open the block', err));
    });
    enableCanvas();
    onChatAsideChange((tab) => {
      if (tab === 'canvas') void canvas();
    });
  },
};

/** @type {import('./registry.js').Feature} */
const compareFeature = {
  id: 'compare',
  mount(el, ctx) {
    shell = ctx;
    mounts.compare = el;
    onChatAsideChange((tab) => {
      if (tab === 'compare') void compare();
    });
    registerMessageAction({
      id: 'compare',
      labelKey: 'canvas.compare.action',
      icon: 'columns-2',
      when: (node) => node.role === 'assistant' && node.parentId !== null,
      run: async (node, c) => {
        const question = await questionOf(node);
        if (!question) {
          ctx.toast('canvas.compare.no_question', { tone: 'warn' });
          return;
        }
        (await compare()).openCompare({ conversationId: c.conversationId, questionId: question.id, text: question.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n\n'), first: pickerValueOf(node) });
      },
    });
    registerMessageAction({
      id: 'council',
      labelKey: 'canvas.council.action',
      icon: 'network',
      when: (node) => node.role === 'assistant' && node.parentId !== null,
      run: async (node, c) => {
        const question = await questionOf(node);
        if (!question) {
          ctx.toast('canvas.compare.no_question', { tone: 'warn' });
          return;
        }
        await (await council()).askCouncil({ conversationId: c.conversationId, questionId: question.id });
      },
    });
    registerComposerTool({
      id: 'compare',
      labelKey: 'canvas.compare.tool',
      icon: 'columns-2',
      run: async () => {
        const text = takeComposerText();
        (await compare()).openCompare({ text });
      },
    });
    registerComposerTool({
      id: 'council',
      labelKey: 'canvas.council.tool',
      icon: 'network',
      run: async () => {
        const text = takeComposerText();
        if (!text) {
          ctx.toast('canvas.council.need_question', { tone: 'warn' });
          return;
        }
        await (await council()).askCouncil({ text });
      },
    });
    // Answers chosen in a comparison or written by the council say so (after the module loads).
    registerAnswerDecorator((answerEl, node) => {
      const meta = /** @type {Record<string, unknown>} */ (node.meta ?? {});
      if (meta.council) void council().then((m) => m.decorateCouncil(answerEl, node));
      if (meta.compare) void compare().then((m) => m.decorateCompared(answerEl, node));
    });
  },
};

registerFeature('chat-aside-canvas', canvasFeature);
registerFeature('chat-aside-compare', compareFeature);
