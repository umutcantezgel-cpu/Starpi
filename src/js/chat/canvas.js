// @ts-check
/**
 * @file The canvas in the chat side panel (#chat-aside, tab Canvas): a document opened from a code
 * block of an answer ("Open in canvas", code-blocks.js), edited in a textarea or read highlighted,
 * with its versions, "Edit with AI", Copy, Download and a preview in the sandboxed render frame.
 *
 * Documents are kept in the app database (store `artifacts`, one record per document with all its
 * versions); a chat that is deleted takes its documents along (chat/store.js).
 * - Opening a block: a block with a fence title opens the document of this chat with that title
 *   and type, an untitled block the open document when it is of this chat and language; otherwise
 *   it starts a new document. A block that differs from the newest version becomes a new version
 *   (each revision a model writes is a version), one that equals a version selects it.
 * - Versions: a model's block, the user's saved edit ("Save as new version", and on leaving a
 *   version with unsaved changes), an AI edit. Choosing a version shows it; nothing is ever
 *   overwritten.
 * - Edit with AI: the selection (or the whole document) and an instruction become a new turn of
 *   the chat (the document goes along in the turn's context block, chat/hooks.js registerTurnNotes);
 *   the answer's code block (else its text) replaces the selection as a new version.
 * - Preview: HTML, SVG and diagrams render in the render frame (render.js mountRenderFrame); HTML
 *   scripts run only after "Run preview". Markdown documents read rendered.
 */
import { chatData, currentSessionId } from '../chat-store.js';
import { downloadName } from '../code-blocks.js';
import { LIMITS } from '../config.js';
import { downloadText, onAction, onChange, setHtml } from '../dom.js';
import { formatDate, formatNumber, getLocale, onLocaleChange, setText, t } from '../i18n/index.js';
import { enhanceRendered, MAX_PREVIEW_CHARS, mountRenderFrame, renderMarkdown } from '../render.js';
import { appDb } from '../store/schema.js';
import { html, icon, label, segmented, setSegmentedValue } from '../ui/kit.js';
import { registerTurnNotes } from './hooks.js';
import { nodeText } from './tree.js';

/** @typedef {import('../store/schema.js').ArtifactRecord} ArtifactRecord */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {'html' | 'svg' | 'mermaid' | 'markdown' | 'code'} ArtifactType */

/**
 * One version of a document: who wrote it and from which message.
 * @typedef {object} ArtifactVersion
 * @property {string} content
 * @property {number} at          epoch ms
 * @property {'model' | 'you' | 'ai'} by
 * @property {string} [nodeId]    the answer it came from
 * @property {string} [model]     the model's display name
 */

/**
 * A canvas document as the store keeps it.
 * @typedef {Omit<ArtifactRecord, 'type' | 'versions'> & { type: ArtifactType, language: string, versions: ArtifactVersion[], updatedAt: number }} CanvasArtifact
 */

/** What "Open in canvas" hands over (code-blocks.js OPEN_CANVAS_EVENT). */
/** @typedef {{ code: string, language: string, title: string }} CanvasBlock */

/** Versions kept per document: the first and the newest ones. */
export const MAX_VERSIONS = 50;
/** Longest document the canvas takes (the render frame takes no more). */
export const MAX_DOCUMENT_CHARS = MAX_PREVIEW_CHARS;
/** Characters of the document that go along with an AI edit (around the passage). */
export const EDIT_CONTEXT_CHARS = 40_000;

const TYPES = /** @type {Record<string, ArtifactType>} */ ({ html: 'html', htm: 'html', xhtml: 'html', svg: 'svg', mermaid: 'mermaid', mmd: 'mermaid', markdown: 'markdown', md: 'markdown' });
const PREVIEWS = new Set(['html', 'svg', 'mermaid']);

// ---------------------------------------------------------------------------------------------
// Documents and versions (no DOM)
// ---------------------------------------------------------------------------------------------

/**
 * The document type of a fence language.
 * @param {string} language
 * @returns {ArtifactType}
 */
export function artifactType(language) {
  return TYPES[String(language ?? '').toLowerCase()] ?? 'code';
}

/**
 * The document of `list` a block continues, or null for a new one: by title within the chat and
 * type, else (untitled) the open document when it is of this chat and language.
 * @param {readonly CanvasArtifact[]} list  the chat's documents
 * @param {CanvasBlock & { conversationId: string }} block
 * @param {CanvasArtifact | null} open  the document the canvas shows
 * @returns {CanvasArtifact | null}
 */
export function matchArtifact(list, block, open) {
  const type = artifactType(block.language);
  const title = block.title.trim().toLowerCase();
  if (title) return list.find((a) => a.conversationId === block.conversationId && a.type === type && a.title.trim().toLowerCase() === title) ?? null;
  if (open && open.conversationId === block.conversationId && !open.title && open.language === block.language) return open;
  return null;
}

/**
 * A document with one more version, unless its newest version already says the same. Beyond
 * MAX_VERSIONS the oldest versions after the first one go.
 * @param {CanvasArtifact} artifact
 * @param {ArtifactVersion} version
 * @returns {{ artifact: CanvasArtifact, added: boolean, index: number }} index: the version that holds the content
 */
export function withVersion(artifact, version) {
  const same = artifact.versions.findLastIndex((v) => v.content === version.content);
  if (same >= 0 && same === artifact.versions.length - 1) return { artifact, added: false, index: same };
  let versions = [...artifact.versions, { ...version, content: version.content.slice(0, MAX_DOCUMENT_CHARS) }];
  if (versions.length > MAX_VERSIONS) versions = [versions[0], ...versions.slice(versions.length - MAX_VERSIONS + 1)];
  return { artifact: { ...artifact, versions, updatedAt: version.at }, added: true, index: versions.length - 1 };
}

/**
 * A new document from a block.
 * @param {CanvasBlock & { conversationId: string, nodeId: string, model?: string }} block
 * @param {{ id?: string, now?: number }} [opts]
 * @returns {CanvasArtifact}
 */
export function newArtifact(block, opts = {}) {
  const at = opts.now ?? Date.now();
  return {
    id: opts.id ?? crypto.randomUUID(),
    conversationId: block.conversationId,
    nodeId: block.nodeId,
    type: artifactType(block.language),
    language: String(block.language ?? '').toLowerCase(),
    title: block.title.trim().slice(0, 120),
    versions: [{ content: block.code.slice(0, MAX_DOCUMENT_CHARS), at, by: 'model', ...(block.nodeId ? { nodeId: block.nodeId } : {}), ...(block.model ? { model: block.model } : {}) }],
    updatedAt: at,
  };
}

/**
 * Text with the range [start, end) replaced.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} replacement
 */
export function replaceRange(text, start, end, replacement) {
  const a = Math.max(0, Math.min(text.length, Math.trunc(start)));
  const b = Math.max(a, Math.min(text.length, Math.trunc(end)));
  return text.slice(0, a) + replacement + text.slice(b);
}

/**
 * What an AI edit's answer says the passage becomes: its first fenced block, else its text.
 * @param {string} answer
 */
export function extractReplacement(answer) {
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/m.exec(answer);
  if (fence) return fence[3];
  return answer.trim();
}

/**
 * A fence that no line of the text closes early.
 * @param {string} text
 */
function fenceFor(text) {
  return '`'.repeat(Math.max(3, ...[...text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length + 1)));
}

/**
 * The question and the turn note of an AI edit. The question (shown in the chat) carries the
 * instruction and, when it fits, the passage; the note (the turn's context block) the document
 * around the passage, with the passage marked.
 * @param {{ title: string, language: string, instruction: string, document: string, start: number, end: number }} input
 * @returns {{ question: string, note: string }}
 */
export function editRequest(input) {
  const { document: doc, language } = input;
  const whole = input.end <= input.start;
  const start = whole ? 0 : input.start;
  const end = whole ? doc.length : input.end;
  const passage = doc.slice(start, end);
  const title = input.title || t('canvas.untitled');
  const head = t('canvas.edit.question', { title, instruction: input.instruction.trim() });
  const rule = t('canvas.edit.reply_rule');
  const fence = fenceFor(passage);
  const shown = [head, '', t(whole ? 'canvas.edit.whole_passage' : 'canvas.edit.passage'), `${fence}${language}`, passage, fence, '', rule].join('\n');
  const question = shown.length <= LIMITS.chatInputChars - 50 ? shown : [head, '', t('canvas.edit.passage_in_context', { n: formatNumber(passage.length) }), '', rule].join('\n');
  // The document around the passage, within the budget, with the passage between markers.
  const room = Math.max(0, EDIT_CONTEXT_CHARS - passage.length);
  const from = Math.max(0, start - Math.floor(room / 2));
  const to = Math.min(doc.length, end + Math.ceil(room / 2));
  const marked = `${from > 0 ? '…\n' : ''}${doc.slice(from, start)}<<<PASSAGE>>>${passage}<<<END PASSAGE>>>${doc.slice(end, to)}${to < doc.length ? '\n…' : ''}`;
  const docFence = fenceFor(marked);
  const note = [t('canvas.edit.note', { title }), `${docFence}${language}`, marked, docFence].join('\n');
  return { question, note };
}

/**
 * The documents of the app database.
 * @param {() => Promise<StoreDb>} [open]
 */
export function artifactStore(open = appDb) {
  return {
    /**
     * A chat's documents, the most recently changed first.
     * @param {string} conversationId
     * @returns {Promise<CanvasArtifact[]>}
     */
    async list(conversationId) {
      const db = await open();
      /** @type {CanvasArtifact[]} */
      const all = await db.getAllFromIndex('artifacts', 'conversationId', conversationId);
      return all.filter((a) => Array.isArray(a.versions) && a.versions.length > 0).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    /**
     * @param {string} id
     * @returns {Promise<CanvasArtifact | undefined>}
     */
    async get(id) {
      return (await open()).get('artifacts', id);
    },
    /** @param {CanvasArtifact} artifact */
    async put(artifact) {
      await (await open()).put('artifacts', artifact);
      return artifact;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} CanvasDeps
 * @property {(tab?: string) => void} [openAside]  shows the side panel on a tab
 * @property {ReturnType<typeof artifactStore>} [store]
 * @property {(question: string, conversationId: string) => Promise<{ node: NodeRecord } | { error: 'busy' | 'no_answer' }>} [ask]  asks a question as a new chat turn
 */

/** @type {{ el: HTMLElement | null, deps: CanvasDeps, store: ReturnType<typeof artifactStore>, artifact: CanvasArtifact | null, list: CanvasArtifact[], index: number, mode: 'edit' | 'read', dirty: boolean, editing: boolean, preview: ReturnType<typeof mountRenderFrame> | null, selection: { start: number, end: number } }} */
const state = { el: null, deps: {}, store: artifactStore(), artifact: null, list: [], index: 0, mode: 'edit', dirty: false, editing: false, preview: null, selection: { start: 0, end: 0 } };
/** The pending AI edit's question and its note, for the turn note hook. */
/** @type {{ question: string, note: string } | null} */
let pendingEdit = null;
let wired = false;

/** @param {string} selector */
const find = (selector) => /** @type {HTMLElement | null} */ (state.el?.querySelector(selector) ?? null);

/** The textarea of the open document. */
const editor = () => /** @type {HTMLTextAreaElement | null} */ (find('[data-canvas-editor]'));

/**
 * The document's display title.
 * @param {CanvasArtifact} artifact
 */
function titleOf(artifact) {
  return artifact.title || t('canvas.untitled_type', { type: t(`canvas.type.${artifact.type}`) });
}

/**
 * The label of a version in the version list.
 * @param {ArtifactVersion} v
 * @param {number} i
 * @returns {{ key: string, params: Record<string, string> }}
 */
function versionLabel(v, i) {
  const by = v.by === 'you' ? t('canvas.version.by_you') : v.by === 'ai' ? (v.model ? t('canvas.version.by_ai_model', { model: v.model }) : t('canvas.version.by_ai')) : v.model ? t('canvas.version.by_model', { model: v.model }) : t('canvas.version.by_answer');
  return { key: 'canvas.version.option', params: { n: formatNumber(i + 1), by, time: formatDate(new Date(v.at), { timeStyle: 'short' }) } };
}

/**
 * Shows a short status under the document (a live region).
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
function status(key, params) {
  const el = find('[data-canvas-status]');
  if (!el) return;
  setText(el, key, params);
  el.hidden = false;
}

function closePreview() {
  state.preview?.destroy();
  state.preview = null;
  const host = find('[data-canvas-preview]');
  if (host) {
    host.replaceChildren();
    host.hidden = true;
  }
  find('[data-action="canvas-preview"]')?.setAttribute('aria-expanded', 'false');
  const run = find('[data-action="canvas-run-preview"]');
  if (run) run.hidden = true;
}

/** The content the canvas shows: the editor's (with unsaved changes) or the chosen version's. */
function currentContent() {
  const area = editor();
  if (state.mode === 'edit' && area) return area.value;
  return state.artifact?.versions[state.index]?.content ?? '';
}

/** Renders the read view of the chosen version: Markdown rendered, code highlighted. */
function renderRead() {
  const host = find('[data-canvas-read]');
  const artifact = state.artifact;
  if (!host || !artifact) return;
  const content = currentContent();
  if (artifact.type === 'markdown') {
    host.innerHTML = renderMarkdown(content);
  } else {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (artifact.language) code.className = `language-${artifact.language.replace(/[^\w#+.-]/g, '')}`;
    code.textContent = content;
    pre.append(code);
    host.replaceChildren(pre);
  }
  void enhanceRendered(host);
}

/** Shows the chosen mode: the editor or the read view. */
function showMode() {
  const area = editor();
  const read = find('[data-canvas-read]');
  if (area) area.hidden = state.mode !== 'edit';
  if (read) read.hidden = state.mode !== 'read';
  setSegmentedValue(find('.segmented'), state.mode);
  if (state.mode === 'read') renderRead();
  const ai = find('[data-canvas-ai]');
  if (ai) ai.hidden = state.mode !== 'edit';
}

/** Says whether the edit applies to a selection or to the whole document. */
function showSelection() {
  const el = find('[data-canvas-selection]');
  if (!el) return;
  const { start, end } = state.selection;
  if (end > start) setText(el, 'canvas.edit.selection', { n: formatNumber(end - start) });
  else setText(el, 'canvas.edit.whole');
}

function showDirty() {
  const note = find('[data-canvas-dirty]');
  if (note) note.hidden = !state.dirty;
  const save = /** @type {HTMLButtonElement | null} */ (find('[data-action="canvas-save"]'));
  if (save) save.disabled = !state.dirty || state.editing;
}

/** Fills the version list and the editor with the chosen version. */
function showVersion() {
  const artifact = state.artifact;
  if (!artifact) return;
  const select = /** @type {HTMLSelectElement | null} */ (find('[data-canvas-versions]'));
  if (select) {
    select.replaceChildren(
      ...artifact.versions.map((v, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        const { key, params } = versionLabel(v, i);
        setText(option, key, params);
        return option;
      }),
    );
    select.value = String(state.index);
  }
  const area = editor();
  if (area) area.value = artifact.versions[state.index]?.content ?? '';
  state.dirty = false;
  state.selection = { start: 0, end: 0 };
  closePreview();
  showDirty();
  showSelection();
  showMode();
}

/** Renders the whole panel for the open document (or the hint without one). */
function render() {
  const el = state.el;
  if (!el) return;
  closePreview();
  const artifact = state.artifact;
  if (!artifact) {
    setHtml(el, html`<p class="text-sm text-slate-600 flex items-start gap-2" data-canvas-empty>${icon('square-pen', 'w-4 h-4 mt-0.5 flex-shrink-0')}${label('canvas.empty')}</p>`.value);
    return;
  }
  const others = state.list.filter((a) => a.id !== artifact.id);
  const picker = others.length
    ? html`<label class="block"><span class="field-label" data-i18n="canvas.picker_label">${t('canvas.picker_label')}</span><select class="field mt-1" data-change="canvas-pick" data-canvas-picker>${[artifact, ...others].map((a) => html`<option value="${a.id}"${a.id === artifact.id ? html` selected` : ''}>${titleOf(a)}</option>`)}</select></label>`
    : '';
  const canPreview = PREVIEWS.has(artifact.type);
  const btn = (/** @type {string} */ action, /** @type {string} */ glyph, /** @type {string} */ key, extra = '') =>
    html`<button type="button" class="btn btn-secondary px-2 py-1 text-xs" data-action="${action}"${extra ? html` ${extra}` : ''}>${icon(glyph, 'w-3.5 h-3.5')}${label(key)}</button>`;
  setHtml(
    el,
    html`<section class="space-y-3" data-canvas data-artifact="${artifact.id}">
      ${picker}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-slate-900 break-all" data-canvas-title>${titleOf(artifact)}</h3>
        ${label(`canvas.type.${artifact.type}`, { className: 'chip chip-neutral' })}
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        ${segmented({ action: 'canvas-mode', label: 'canvas.mode.label', value: state.mode, options: [{ value: 'edit', label: 'canvas.mode.edit', icon: 'square-pen' }, { value: 'read', label: 'canvas.mode.read', icon: 'file-text' }] })}
        ${btn('canvas-copy', 'copy', 'canvas.copy')}
        ${btn('canvas-download', 'download', 'canvas.download')}
        ${canPreview ? html`<button type="button" class="btn btn-secondary px-2 py-1 text-xs" data-action="canvas-preview" aria-expanded="false" aria-controls="canvasPreview">${icon('monitor', 'w-3.5 h-3.5')}${label('canvas.preview')}</button>` : ''}
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-600"><span data-i18n="canvas.version.label">${t('canvas.version.label')}</span><select class="field py-1 text-xs flex-1 min-w-0" data-change="canvas-version" data-canvas-versions></select></label>
      <textarea class="field font-mono text-xs leading-relaxed min-h-[18rem] w-full" spellcheck="false" aria-label="${t('canvas.editor_label')}" data-i18n-aria="canvas.editor_label" data-canvas-editor></textarea>
      <div class="prose-custom max-h-[32rem] overflow-auto rounded-xl border border-slate-200 p-3 text-sm" tabindex="0" aria-label="${t('canvas.read_label')}" data-i18n-aria="canvas.read_label" data-canvas-read hidden></div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-amber-900" data-canvas-dirty hidden>${label('canvas.unsaved')}</p>
        <button type="button" class="btn btn-secondary px-2 py-1 text-xs ml-auto" data-action="canvas-save" disabled>${icon('check', 'w-3.5 h-3.5')}${label('canvas.save')}</button>
      </div>
      <div id="canvasPreview" class="space-y-2" data-canvas-preview hidden></div>
      <button type="button" class="btn btn-secondary px-2 py-1 text-xs" data-action="canvas-run-preview" aria-label="${t('canvas.run_preview_aria')}" data-i18n-aria="canvas.run_preview_aria" hidden>${icon('zap', 'w-3.5 h-3.5')}${label('canvas.run_preview')}</button>
      <form class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3" data-canvas-ai>
        <p class="text-xs font-semibold text-slate-700 flex items-center gap-1.5">${icon('sparkles', 'w-3.5 h-3.5')}${label('canvas.edit.heading')}</p>
        <label class="block"><span class="sr-only" data-i18n="canvas.edit.instruction">${t('canvas.edit.instruction')}</span><textarea class="field text-sm min-h-[3.5rem] w-full" placeholder="${t('canvas.edit.placeholder')}" data-i18n-placeholder="canvas.edit.placeholder" data-canvas-instruction></textarea></label>
        <p class="text-[11px] text-slate-600" data-canvas-selection></p>
        <button type="submit" class="btn btn-primary px-3 py-1 text-xs" data-canvas-ai-run>${icon('sparkles', 'w-3.5 h-3.5')}${label('canvas.edit.run')}</button>
      </form>
      <p class="text-xs text-slate-700" role="status" aria-live="polite" data-canvas-status hidden></p>
    </section>`.value,
  );
  const area = editor();
  area?.addEventListener('input', () => {
    state.dirty = area.value !== (state.artifact?.versions[state.index]?.content ?? '');
    showDirty();
  });
  const remember = () => {
    if (area) state.selection = { start: area.selectionStart, end: area.selectionEnd };
    showSelection();
  };
  for (const ev of ['select', 'keyup', 'mouseup', 'input']) area?.addEventListener(ev, remember);
  find('[data-canvas-ai]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void editWithAi();
  });
  showVersion();
}

/**
 * Keeps unsaved changes of the editor as a version of their own (before another version, another
 * document or an AI edit replaces what the editor shows).
 * @returns {Promise<void>}
 */
async function keepDraft() {
  const area = editor();
  if (!state.artifact || !state.dirty || !area) return;
  const { artifact, index } = withVersion(state.artifact, { content: area.value, at: Date.now(), by: 'you' });
  state.artifact = await state.store.put(artifact);
  state.index = index;
  state.dirty = false;
}

/** Reads the chat's documents again (for the document picker). */
async function refreshList() {
  const id = state.artifact?.conversationId ?? currentSessionId();
  try {
    state.list = await state.store.list(id);
  } catch (err) {
    console.warn('[starpi] the canvas documents could not be read', err);
    state.list = state.artifact ? [state.artifact] : [];
  }
}

/**
 * Opens a block of an answer in the canvas: as a version of the document it continues, or as a new
 * document (see the file comment).
 * @param {CanvasBlock & { nodeId?: string, model?: string, conversationId?: string }} block
 * @returns {Promise<CanvasArtifact | null>}
 */
export async function openInCanvas(block) {
  const code = String(block.code ?? '');
  if (!code.trim()) return null;
  await keepDraft();
  const conversationId = block.conversationId ?? currentSessionId();
  const full = { code, language: String(block.language ?? '').toLowerCase(), title: String(block.title ?? ''), conversationId, nodeId: block.nodeId ?? '', model: block.model };
  /** @type {CanvasArtifact[]} */
  let list = [];
  try {
    list = await state.store.list(conversationId);
  } catch (err) {
    console.warn('[starpi] the canvas documents could not be read', err);
  }
  const known = matchArtifact(list, full, state.artifact?.conversationId === conversationId ? (list.find((a) => a.id === state.artifact?.id) ?? state.artifact) : null);
  let artifact;
  let index;
  let added = true;
  if (known) {
    const at = known.versions.findIndex((v) => v.content === code);
    if (at >= 0) ({ artifact, index, added } = { artifact: known, index: at, added: false });
    else ({ artifact, index, added } = withVersion(known, { content: code, at: Date.now(), by: 'model', ...(full.nodeId ? { nodeId: full.nodeId } : {}), ...(full.model ? { model: full.model } : {}) }));
  } else {
    artifact = newArtifact(full);
    index = 0;
  }
  try {
    if (added) await state.store.put(artifact);
  } catch (err) {
    // The document still opens; it is not kept beyond this page.
    console.warn('[starpi] the canvas document could not be stored', err);
  }
  state.artifact = artifact;
  state.index = index;
  state.mode = 'edit';
  await refreshList();
  state.deps.openAside?.('canvas');
  render();
  if (known && added) status('canvas.added_version', { n: formatNumber(index + 1), title: titleOf(artifact) });
  return artifact;
}

/** Saves the editor's content as a new version. */
async function saveVersion() {
  if (!state.artifact || !state.dirty) return;
  await keepDraft();
  showVersion();
  status('canvas.saved', { n: formatNumber(state.index + 1) });
}

/**
 * Asks a question as a new turn of the chat and returns its answer (the chat's own path).
 * @param {string} question
 * @param {string} conversationId
 * @returns {Promise<{ node: NodeRecord } | { error: 'busy' | 'no_answer' }>}
 */
async function askInChat(question, conversationId) {
  const chat = await import('../chat.js');
  if (chat.isChatBusy()) return { error: 'busy' };
  if (currentSessionId() !== conversationId) await chat.openConversation(conversationId);
  const asked = question.trim().slice(0, LIMITS.chatInputChars);
  const started = Date.now();
  await chat.submitChat(question, { chatMode: 'free' });
  const thread = await (await chatData()).loadThread(conversationId);
  const answer = thread?.path.at(-1);
  const q = thread?.path.at(-2);
  if (answer?.role === 'assistant' && q && nodeText(q) === asked && answer.createdAt >= started - 1000 && nodeText(answer).trim()) return { node: answer };
  return { error: 'no_answer' };
}

/** "Edit with AI": the selection (or the whole document) and the instruction as a new chat turn. */
async function editWithAi() {
  const artifact = state.artifact;
  const area = editor();
  const input = /** @type {HTMLTextAreaElement | null} */ (find('[data-canvas-instruction]'));
  if (!artifact || !area || !input || state.editing) return;
  const instruction = input.value.trim();
  if (!instruction) {
    status('canvas.edit.empty_instruction');
    input.focus();
    return;
  }
  const { start, end } = state.selection;
  await keepDraft();
  const base = artifact.id === state.artifact?.id ? (state.artifact?.versions[state.index]?.content ?? area.value) : area.value;
  const req = editRequest({ title: artifact.title, language: artifact.language, instruction, document: base, start, end });
  state.editing = true;
  const run = /** @type {HTMLButtonElement | null} */ (find('[data-canvas-ai-run]'));
  if (run) run.disabled = true;
  area.readOnly = true;
  showDirty();
  status('canvas.edit.running');
  pendingEdit = { question: req.question.trim().slice(0, LIMITS.chatInputChars), note: req.note };
  try {
    const ask = state.deps.ask ?? askInChat;
    const res = await ask(req.question, artifact.conversationId);
    if ('error' in res) {
      status(res.error === 'busy' ? 'canvas.edit.busy' : 'canvas.edit.failed');
      return;
    }
    const replacement = extractReplacement(nodeText(res.node));
    const content = end > start ? replaceRange(base, start, end, replacement) : replacement;
    const model = res.node.model ? String(res.node.model) : '';
    const current = state.artifact?.id === artifact.id ? state.artifact : artifact;
    const next = withVersion(current, { content, at: Date.now(), by: 'ai', nodeId: res.node.id, ...(model ? { model } : {}) });
    state.artifact = await state.store.put(next.artifact);
    state.index = next.index;
    input.value = '';
    showVersion();
    status('canvas.edit.done', { n: formatNumber(next.index + 1) });
  } catch (err) {
    console.warn('[starpi] the AI edit failed', err);
    status('canvas.edit.failed');
  } finally {
    pendingEdit = null;
    state.editing = false;
    const again = editor();
    if (again) again.readOnly = false;
    const button = /** @type {HTMLButtonElement | null} */ (find('[data-canvas-ai-run]'));
    if (button) button.disabled = false;
    showDirty();
  }
}

/** Shows or hides the preview of the shown content in the render frame. */
function togglePreview() {
  const artifact = state.artifact;
  const host = find('[data-canvas-preview]');
  const toggle = find('[data-action="canvas-preview"]');
  if (!artifact || !host || !PREVIEWS.has(artifact.type)) return;
  if (state.preview) {
    closePreview();
    return;
  }
  const source = currentContent();
  if (!source.trim() || source.length > MAX_PREVIEW_CHARS) return;
  const frameHost = document.createElement('div');
  frameHost.className = 'code-preview-frame rounded-xl border border-slate-200 overflow-hidden';
  const note = document.createElement('p');
  note.className = 'text-xs text-amber-900';
  note.setAttribute('role', 'status');
  note.hidden = true;
  host.replaceChildren(frameHost, note);
  host.hidden = false;
  state.preview = mountRenderFrame(frameHost, {
    kind: /** @type {import('../render.js').PreviewKind} */ (artifact.type),
    source,
    title: t('canvas.preview_title'),
    onError: (code) => {
      note.hidden = false;
      setText(note, code === 'diagram' ? 'canvas.diagram_error' : 'canvas.preview_error');
    },
  });
  state.preview.frame.setAttribute('data-i18n-title', 'canvas.preview_title');
  toggle?.setAttribute('aria-expanded', 'true');
  const run = find('[data-action="canvas-run-preview"]');
  if (run) run.hidden = artifact.type !== 'html';
}

async function copyContent() {
  const ok = await navigator.clipboard.writeText(currentContent()).then(
    () => true,
    () => false,
  );
  status(ok ? 'canvas.copied' : 'canvas.copy_failed');
}

function downloadContent() {
  const artifact = state.artifact;
  if (!artifact) return;
  const language = artifact.language || (artifact.type === 'code' ? 'txt' : artifact.type);
  downloadText(downloadName({ language, title: artifact.title }), currentContent(), 'text/plain;charset=utf-8');
}

/**
 * Shows another version (unsaved changes become a version first).
 * @param {number} index
 */
async function chooseVersion(index) {
  if (!state.artifact || !Number.isInteger(index) || index < 0 || index >= state.artifact.versions.length) return;
  const wanted = state.artifact.versions[index];
  await keepDraft();
  // Unsaved changes became the newest version; the chosen one keeps its place (or moved up when old ones went).
  state.index = Math.max(0, state.artifact.versions.indexOf(wanted));
  showVersion();
}

/**
 * Shows another document of the chat.
 * @param {string} id
 */
async function chooseArtifact(id) {
  await keepDraft();
  const artifact = state.list.find((a) => a.id === id) ?? (await state.store.get(id));
  if (!artifact) return;
  state.artifact = artifact;
  state.index = artifact.versions.length - 1;
  await refreshList();
  render();
}

/**
 * Mounts the canvas into its panel. The handlers are registered once.
 * @param {HTMLElement} el
 * @param {CanvasDeps} [deps]
 */
export function mountCanvas(el, deps = {}) {
  state.el = el;
  state.deps = deps;
  if (deps.store) state.store = deps.store;
  render();
  if (wired) return;
  wired = true;
  // The document goes along with the AI edit's question, in the turn's context block.
  registerTurnNotes((ctx) => (pendingEdit && ctx.question === pendingEdit.question ? [pendingEdit.note] : []));
  onAction('canvas-mode', (btn) => {
    const mode = btn.dataset.arg === 'read' ? 'read' : 'edit';
    if (mode === state.mode) return;
    state.mode = mode;
    closePreview();
    showMode();
  });
  onAction('canvas-copy', () => copyContent());
  onAction('canvas-download', () => downloadContent());
  onAction('canvas-save', () => saveVersion());
  onAction('canvas-preview', () => togglePreview());
  onAction('canvas-run-preview', () => state.preview?.run());
  onChange('canvas-version', (select) => chooseVersion(Number(/** @type {HTMLSelectElement} */ (select).value)));
  onChange('canvas-pick', (select) => chooseArtifact(/** @type {HTMLSelectElement} */ (select).value));
  // Version labels carry times and model names composed in the language of the moment.
  onLocaleChange(() => {
    if (state.artifact) {
      const select = /** @type {HTMLSelectElement | null} */ (find('[data-canvas-versions]'));
      for (const option of select?.querySelectorAll('option') ?? []) {
        const i = Number(option.value);
        const v = state.artifact.versions[i];
        if (v) setText(option, versionLabel(v, i).key, versionLabel(v, i).params);
      }
    }
  });
}

/** What the canvas shows (for tests and the e2e suite). */
export function canvasState() {
  return { artifact: state.artifact, index: state.index, dirty: state.dirty, editing: state.editing, locale: getLocale() };
}
