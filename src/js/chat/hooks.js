// @ts-check
// The chat's hook points for the features that build on it. Kept apart from the thread and the
// composer (and free of imports) so a feature can register without loading the chat: the thread and
// the composer read these registries when they need them. thread.js and composer.js re-export the
// registration functions and describe them in their headers.
//
// Every register* function returns a function that removes the registration again.

/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('../core/receipt.js').ReceiptDraft} ReceiptDraft */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../config.js').ChatMode} ChatMode */

/**
 * What a question looks like to a hook.
 * @typedef {object} TurnContext
 * @property {string} conversationId
 * @property {string} question            the text the user typed
 * @property {ChatMode} mode              the mode control's setting
 * @property {'free' | 'grounded'} route  how the question is answered
 * @property {{ provider: string, model: string } | null} target  the model asked first (null: none)
 * @property {string} locale
 * @property {readonly { name: string, kind: string }[]} attachments
 * @property {boolean} [localOnly]        the question stays on this device: a hook sends nothing of
 *   it anywhere else (no search service, no tool that reaches beyond this device)
 */

/**
 * The route decision of Auto (and of explicit modes, which a decider must keep).
 * @typedef {(input: { question: string, mode: ChatMode, attachments: readonly { name: string, kind: string }[], workspaceDocs: number, knowledgeDocs?: number, modelReady?: boolean }) => Promise<{ route: 'free' | 'grounded' } | null> | { route: 'free' | 'grounded' } | null} RouteDecider
 */

/**
 * An action on a message (shown in its action bar after the built-in ones).
 * @typedef {object} MessageAction
 * @property {string} id                 unique; becomes data-arg of the button
 * @property {string} labelKey           i18n key of the button's accessible name and tooltip
 * @property {string} icon               a lucide icon registered in icons.js
 * @property {(node: NodeRecord) => boolean} [when]  whether the action fits this message (default: answers)
 * @property {(node: NodeRecord, ctx: { element: HTMLElement, conversationId: string }) => unknown} run
 */

/**
 * The workspace documents a conversation's grounded questions search (null: all of them; files
 * attached to the question are searched as well).
 * @typedef {(conversationId: string) => readonly string[] | null | Promise<readonly string[] | null>} WorkspaceScope
 */

/**
 * What a sidebar section gets from the conversation list.
 * @typedef {object} SidebarSectionContext
 * @property {typeof import('../dom.js').onAction} onAction
 * @property {typeof import('../dom.js').onChange} onChange
 * @property {(tab: string) => void} switchTab
 * @property {typeof import('../ui/kit.js').toast} toast
 */

/**
 * An entry of the composer's tools menu.
 * @typedef {object} ComposerTool
 * @property {string} id
 * @property {string} labelKey
 * @property {string} icon
 * @property {() => unknown} run
 */

/**
 * @template T
 * @param {Set<T>} set
 * @param {T} value
 * @returns {() => void}
 */
function add(set, value) {
  set.add(value);
  return () => set.delete(value);
}

/** @type {Set<(ctx: TurnContext) => readonly string[] | Promise<readonly string[]>>} */
export const turnNoteHooks = new Set();
/** @type {Set<(ctx: TurnContext) => readonly string[] | Promise<readonly string[]>>} */
export const requestNoteHooks = new Set();
/** @type {Set<(ctx: TurnContext) => string | Promise<string>>} */
export const systemNoteHooks = new Set();
/** @type {Set<(req: AiRequest, ctx: TurnContext) => AiRequest>} */
export const requestHooks = new Set();
/** @type {Set<(draft: ReceiptDraft, ctx: { answer: string, question: string }) => ReceiptDraft | Promise<ReceiptDraft>>} */
export const receiptHooks = new Set();
/** @type {Map<string, MessageAction>} */
export const messageActions = new Map();
/** @type {Map<string, ComposerTool>} */
export const composerTools = new Map();
/** @type {Map<string, (slot: HTMLElement) => void | (() => void)>} */
export const composerSlots = new Map();
/** @type {Map<string, (host: HTMLElement, ctx: SidebarSectionContext) => void | (() => void)>} */
export const sidebarSections = new Map();
/** @type {Set<() => void>} */
const sidebarListeners = new Set();
/** @type {Set<(el: HTMLElement, node: NodeRecord) => void>} */
export const answerDecorators = new Set();
/** @type {Set<() => void>} */
const slotListeners = new Set();
/** @type {Set<() => void>} */
const toolListeners = new Set();

/**
 * What the tool runner gets for a free answer: the answer, the request it was asked with (built on
 * demand), the turn, Stop, and the answer's bubble (for approval cards and the text after tool calls).
 * @typedef {{ result: CompletionResult, request: () => Promise<AiRequest>, ctx: TurnContext, signal: AbortSignal, view?: { element: HTMLElement, update: (text: string) => void } }} ToolRunInput
 */

/**
 * What the tool runner returns: the answer after its tool calls, with the web check it made itself
 * when the question went out with search results (the verified web answer), in the shape of
 * rag/web-check.js, so the answer is labelled and stored as the thread's web check would.
 * @typedef {CompletionResult & { webCheck?: import('../rag/web-check.js').WebCheck }} ToolRunResult
 */

/**
 * Another adapter for one call of a free answer (provider-side tools); undefined keeps the default.
 * @typedef {(target: { provider: string, model: string, route: string }, req: AiRequest) => import('../ai/stream.js').Adapter | undefined} AdapterChooser
 */

/**
 * The memory feature's side of the memory_lookup tool: whether memory is on (read when a request
 * offers its tools, so the tool is offered only then) and the saved notes that match a query, from
 * the scopes the conversation may use (its project's setting).
 * @typedef {object} MemoryLookup
 * @property {() => boolean} enabled
 * @property {(query: string, limit: number, conversationId: string | null) => Promise<Array<{ text: string, updatedAt?: string }>>} lookup
 */

/** @type {{ scope: WorkspaceScope | null, route: RouteDecider | null, tools: ((input: ToolRunInput) => Promise<ToolRunResult | null>) | null, label: ((node: NodeRecord) => { kind: import('../ui/kit.js').Provenance, labelKey?: string } | null) | null, adapter: AdapterChooser | null, memory: MemoryLookup | null }} */
export const single = { scope: null, route: null, tools: null, label: null, adapter: null, memory: null };

/**
 * Notes for the current user turn of a free-chat question (memory facts, context packs). They go
 * into the turn's context block, never into the stable system prompt.
 * @param {(ctx: TurnContext) => readonly string[] | Promise<readonly string[]>} fn
 */
export function registerTurnNotes(fn) {
  return add(turnNoteHooks, fn);
}

/**
 * Notes for the request of the free question being answered only (saved notes about the user). They
 * go into a context block of that request and are never stored with the question, so later turns
 * do not send them again: what the feature holds back later (switched off, deleted, encrypted)
 * stays held back. Asked again for a regenerated answer; not asked for "Continue".
 * @param {(ctx: TurnContext) => readonly string[] | Promise<readonly string[]>} fn
 */
export function registerRequestNotes(fn) {
  return add(requestNoteHooks, fn);
}

/**
 * Text appended to the free chat's system prompt (custom instructions). It must stay the same from
 * turn to turn of a conversation, or the provider's prompt cache is lost.
 * @param {(ctx: TurnContext) => string | Promise<string>} fn
 */
export function registerSystemNote(fn) {
  return add(systemNoteHooks, fn);
}

/**
 * Changes a request before it goes out (for example tools offered to the model).
 * @param {(req: AiRequest, ctx: TurnContext) => AiRequest} fn
 */
export function registerRequestHook(fn) {
  return add(requestHooks, fn);
}

/**
 * Completes the receipt draft of a grounded answer (relations, second opinions) before it is kept.
 * @param {(draft: ReceiptDraft, ctx: { answer: string, question: string }) => ReceiptDraft | Promise<ReceiptDraft>} fn
 */
export function registerReceiptHook(fn) {
  return add(receiptHooks, fn);
}

/**
 * Limits the workspace search of a conversation's grounded questions (one scope; a later one
 * replaces it).
 * @param {WorkspaceScope | null} fn
 */
export function setWorkspaceScope(fn) {
  single.scope = fn;
  return () => {
    if (single.scope === fn) single.scope = null;
  };
}

/**
 * Decides Free or Grounded for Auto (one decider; a later one replaces it). Returning null keeps the
 * built-in rule.
 * @param {RouteDecider | null} fn
 */
export function setRouteDecider(fn) {
  single.route = fn;
  return () => {
    if (single.route === fn) single.route = null;
  };
}

/**
 * Sees every free answer once it is in: runs the tool calls an answer stopped for (and may complete
 * it otherwise, such as linking its web results) and returns the answer after that (null: leave it).
 * @param {typeof single.tools} fn
 */
export function setToolRunner(fn) {
  single.tools = fn;
  return () => {
    if (single.tools === fn) single.tools = null;
  };
}

/**
 * Lets the memory feature answer the memory_lookup tool (one; a later one replaces it). Until then,
 * and while memory is off, the tool is not offered.
 * @param {MemoryLookup | null} lookup
 */
export function setMemoryLookup(lookup) {
  single.memory = lookup;
  return () => {
    if (single.memory === lookup) single.memory = null;
  };
}

/**
 * Picks another adapter for a call of a free answer (one chooser; a later one replaces it).
 * @param {AdapterChooser | null} fn
 */
export function setAdapterChooser(fn) {
  single.adapter = fn;
  return () => {
    if (single.adapter === fn) single.adapter = null;
  };
}

/**
 * The provenance label of an answer (until set, the thread labels free answers "not checked" and
 * grounded ones "checked against your sources").
 * @param {typeof single.label} fn
 */
export function setAnswerLabeler(fn) {
  single.label = fn;
  return () => {
    if (single.label === fn) single.label = null;
  };
}

/**
 * Adds an action to the action bar of messages.
 * @param {MessageAction} action
 */
export function registerMessageAction(action) {
  if (!action?.id || typeof action.run !== 'function') throw new TypeError('registerMessageAction({ id, labelKey, icon, run }) needs an id and a run function');
  messageActions.set(action.id, action);
  return () => {
    if (messageActions.get(action.id) === action) messageActions.delete(action.id);
  };
}

/**
 * Adds to how an answer shows (a note under it, such as how it was chosen): fn gets the answer's
 * element and its stored message every time the thread shows that answer.
 * @param {(el: HTMLElement, node: NodeRecord) => void} fn
 */
export function registerAnswerDecorator(fn) {
  return add(answerDecorators, fn);
}

/**
 * Fills a slot of the composer: 'mic' (dictation) or 'voice' (voice mode). The render function gets
 * the slot element and may return a cleanup function; a later registration replaces it.
 * @param {'mic' | 'voice'} name
 * @param {(slot: HTMLElement) => void | (() => void)} render
 */
export function registerComposerSlot(name, render) {
  composerSlots.set(name, render);
  for (const fn of slotListeners) fn();
  return () => {
    if (composerSlots.get(name) === render) {
      composerSlots.delete(name);
      for (const fn of slotListeners) fn();
    }
  };
}

/**
 * Adds an entry to the composer's tools menu.
 * @param {ComposerTool} tool
 */
export function registerComposerTool(tool) {
  composerTools.set(tool.id, tool);
  for (const fn of toolListeners) fn();
  return () => {
    if (composerTools.get(tool.id) === tool) {
      composerTools.delete(tool.id);
      for (const fn of toolListeners) fn();
    }
  };
}

/**
 * Adds a section to the sidebar, between the search box and the conversation list (projects,
 * assistants). The render function gets its own host element and may return a cleanup function;
 * sections show in registration order, and a later registration of the same id replaces it.
 * @param {string} id
 * @param {(host: HTMLElement, ctx: SidebarSectionContext) => void | (() => void)} render
 */
export function registerSidebarSection(id, render) {
  sidebarSections.set(id, render);
  for (const fn of sidebarListeners) fn();
  return () => {
    if (sidebarSections.get(id) === render) {
      sidebarSections.delete(id);
      for (const fn of sidebarListeners) fn();
    }
  };
}

/** @param {() => void} fn  the conversation list renders its sections again */
export function onSidebarSections(fn) {
  return add(sidebarListeners, fn);
}

/** @param {() => void} fn  the composer re-renders its slots */
export function onComposerSlots(fn) {
  return add(slotListeners, fn);
}

/** @param {() => void} fn  the composer re-renders its tools menu */
export function onComposerTools(fn) {
  return add(toolListeners, fn);
}
