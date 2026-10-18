// @ts-check
/**
 * @file The conversation thread: shows the active path of a stored conversation (chat/store.js),
 * sends questions, streams answers through the AI layer (chat/runner.js), and keeps the message
 * tree append-only: editing a question and regenerating an answer add siblings, Continue after the
 * length limit adds a new turn, and the branch navigator switches the active leaf.
 *
 * Two routes per question (mode-control.js decides for Auto):
 * - free: the stable free-chat system prompt (prompts.js freeSystemPrompt), the conversation as
 *   history and the question with its attachments and a per-turn context block (date and time,
 *   notes). Answers are labelled "not checked". Anthropic conversations are replayed whole with
 *   every answer's provider state (thinking blocks with signatures) unchanged, and compacted on
 *   the server near the limit; every other provider's history is trimmed to the model's context.
 * - grounded: retrieval from the on-device workspace and the knowledge base, the excerpts in the
 *   system prompt, the source check on the streamed answer, a receipt (with what the sentence gate
 *   released and withheld), and the answer quoted from the sources when no model answers.
 *
 * Hook points for other features (registered in hooks.js, re-exported here):
 * - setRouteDecider(fn): Auto's route decision ({ route: 'free' | 'grounded' } or null).
 * - registerTurnNotes(fn): notes for the context block of a free question (memory, packs).
 * - registerSystemNote(fn): text appended to the free system prompt (stable per conversation).
 * - registerRequestHook(fn): changes a request before it goes out (tools).
 * - setToolRunner(fn): runs the tool calls an answer stopped for.
 * - registerReceiptHook(fn): completes a grounded answer's receipt draft (relations, second opinions).
 * - registerMessageAction(action): an action in every message's bar ("Research this", read aloud).
 * - setAnswerLabeler(fn): the provenance label of an answer.
 */
import { chatData, currentSessionId, loadSessionThread } from '../chat-store.js';
import { APP_VERSION, LIMITS, TIMEOUTS_MS } from '../config.js';
import { contextCoverage } from '../core/grounding.js';
import { startLocalEngine } from '../engine-ui.js';
import { formatNumber, getLocale, setText, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { appendLoading, appendMessage, appendNotice, createStreamingMessage, markFreeAnswer, resetMessages } from '../messages.js';
import { modelLabel, providerLabel } from '../providers.js';
import { attachmentSection, buildInstructions, buildSystemPrompt, contextSection, cutFenced, estimateTokens, fitPoolRequest, freeSystemPrompt, historyWindow, trimHistory, turnContext } from '../prompts.js';
import { registerCitations } from '../rag/citations.js';
import { libraryHitsByMeaning } from '../rag/embed-client.js';
import { applyGrounding } from '../rag/grounding-view.js';
import { receiptButton, storeReceiptDraft } from '../rag/receipts.js';
import { addToWorkspace, firstChunks, getDocumentText, listWorkspace, searchWorkspace } from '../rag/workspace.js';
import { assignCitations, buildContext, distinctSources, mergeHits, rankHitsLocally, workspaceHit } from '../retrieval.js';
import { getAssistant, getChatMode, getWebSearch, setChatMode } from '../state.js';
import { getConnection, listDocuments, recentKnowledge, searchKnowledge } from '../supabase.js';
import { describeChatTrace, describeTrace, isGreeting, synthesizeAnswer } from '../synthesizer.js';
import { setAssistantStatus } from '../ui.js';
import { html, provenanceBadge } from '../ui/kit.js';
import { mountGroundingFrame } from '../render.js';
import { getEngineState, interrupt } from '../webgpu/engine.js';
import { budgetPrompt } from '../webgpu/models.js';
import { applyThinking, thinkingFor } from '../ai/thinking.js';
import { renderActions } from './actions.js';
import { attachmentText, blobToBase64, MAX_NATIVE_PDF_BYTES, needsVision, textBudget } from './attachments.js';
import { clearComposer, setComposerBusy, takeDraft } from './composer.js';
import { receiptHooks, requestHooks, single, systemNoteHooks, turnNoteHooks } from './hooks.js';
import { decideRoute } from './mode-control.js';
import { capsOf, chatCandidates, compactingAnthropic, runAnswer } from './runner.js';
import { activePath, branchInfo, indexNodes, nodeText, switchBranch } from './tree.js';

export {
  registerMessageAction,
  registerReceiptHook,
  registerRequestHook,
  registerSystemNote,
  registerTurnNotes,
  setAnswerLabeler,
  setRouteDecider,
  setToolRunner,
} from './hooks.js';

/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../store/schema.js').StoredPart} StoredPart */
/** @typedef {import('./store.js').Thread} Thread */
/** @typedef {import('./store.js').ChatStore} ChatStore */
/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/contract.js').Message} Message */
/** @typedef {import('../ai/contract.js').Part} Part */
/** @typedef {import('../ai/contract.js').Caps} Caps */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('./runner.js').Target} Target */
/** @typedef {import('./runner.js').ChatAttempt} ChatAttempt */
/** @typedef {import('./attachments.js').PreparedAttachment} PreparedAttachment */
/** @typedef {import('./hooks.js').TurnContext} TurnContext */
/** @typedef {import('../supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('../config.js').AssistantValue} AssistantValue */

/** i18n keys of the engines of 2.x answers (stored with the message as `engine`). */
const LEGACY_ENGINES = /** @type {Record<string, string>} */ ({
  cloud: 'engine.label_cloud',
  client: 'engine.label_client',
  wasm: 'engine.label_wasm',
  local: 'engine.label_server',
  nvidia: 'engine.label_nvidia',
  synthesizer: 'engine.label_synthesizer',
});
/** The trace of a free answer has one phase after the model's own reasoning: the answer. */
const FREE_TRACE_ROLES = ['trace.role_answer'];
/** Turns of history a grounded question takes along, as in 2.x. */
const GROUNDED_WINDOW = Object.freeze({ turns: 4, turnChars: Infinity, totalChars: Infinity });
/** Estimated size from which an Anthropic conversation asks for server-side compaction. */
export const COMPACTION_TOKENS = 100_000;
/** Longest reasoning kept with an answer (for its details block). */
const REASONING_CHARS = 20_000;
/** Output tokens of a cloud answer; Continue picks up an answer that reaches it. */
const CLOUD_ANSWER_TOKENS = 16_000;
const SERVER_ANSWER_TOKENS = 4_096;

let conversationId = currentSessionId();
/** @type {Thread | null} */
let current = null;
let busy = false;
/** @type {AbortController | null} */
let controller = null;
let showSeq = 0;
/** Base64 and text of stored attachments, by blob id. */
/** @type {Map<string, string>} */
const blobData = new Map();
/** @type {{ at: number, titles: string[] } | null} */
let titlesCache = null;

/** The conversation the thread shows. */
export function threadConversationId() {
  return conversationId;
}

export function isThreadBusy() {
  return busy;
}

/** @param {string} id */
export function threadNode(id) {
  return current?.tree.byId.get(id) ?? null;
}

export function invalidateKnownTitles() {
  titlesCache = null;
}

/** @returns {Promise<ChatStore>} */
function store() {
  return chatData();
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  setComposerBusy(on);
  document.getElementById('chatMessages')?.setAttribute('aria-busy', String(on));
  setAssistantStatus(on ? 'status.generating' : 'status.ready');
  refreshBars();
}

async function reload() {
  current = await (await store()).loadThread(conversationId);
}

/** The newest message of the active path. */
function leafId() {
  return current?.path.at(-1)?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Showing messages
// ---------------------------------------------------------------------------------------------

/** @param {NodeRecord} node */
function metaOf(node) {
  return /** @type {Record<string, any>} */ (node.meta ?? {});
}

/**
 * The engine label of an answer, as an i18n key with parameters (model names only as parameters).
 * @param {NodeRecord | { provider: string | null, model: string | null, meta?: Record<string, unknown> }} node
 * @returns {{ badge: string, badgeParams: Record<string, string> | undefined }}
 */
export function answerBadge(node) {
  const meta = /** @type {Record<string, any>} */ (node.meta ?? {});
  const provider = /** @type {import('../ai/contract.js').ProviderId | null} */ (node.provider);
  const model = node.model ?? '';
  if (meta.engine === 'synthesizer') return { badge: 'engine.label_synthesizer', badgeParams: undefined };
  if (!provider) {
    const key = LEGACY_ENGINES[meta.engine] ?? '';
    const name = model && meta.engine === 'nvidia' ? modelLabel('nvidia', model) : model;
    return { badge: key, badgeParams: name ? { model: name } : undefined };
  }
  const params = { provider: providerLabel(provider), model: modelLabel(provider, model) };
  if (provider === 'webgpu' || provider === 'wasm') return { badge: 'chat-thread.badge.device', badgeParams: params };
  if (provider === 'local') return { badge: 'chat-thread.badge.server', badgeParams: params };
  const requested = typeof meta.requested === 'string' && meta.requested && meta.requested !== model ? modelLabel(provider, meta.requested) : '';
  if (requested) return { badge: 'chat-thread.badge.served', badgeParams: { ...params, requested } };
  return { badge: meta.route === 'pool' ? 'chat-thread.badge.pool' : 'chat-thread.badge.provider', badgeParams: params };
}

/**
 * The usage and latency line of an answer.
 * @param {NodeRecord} node
 */
function metaLine(node) {
  const meta = metaOf(node);
  const parts = [];
  if (node.usage) {
    parts.push(t('chat-thread.meta.tokens', { input: formatNumber(node.usage.input), output: formatNumber(node.usage.output) }));
    if (node.usage.cacheRead) parts.push(t('chat-thread.meta.cached', { n: formatNumber(node.usage.cacheRead) }));
    if (typeof node.usage.costUsd === 'number' && node.usage.costUsd > 0) parts.push(t('chat-thread.meta.cost', { usd: formatNumber(node.usage.costUsd, { maximumFractionDigits: 4 }) }));
  }
  if (typeof meta.duration_ms === 'number') parts.push(`${formatNumber(meta.duration_ms / 1000, { maximumFractionDigits: 1 })} s`);
  return parts.join(' · ');
}

/**
 * The provenance label of an answer: a registered labeler's, else "not checked" for free answers
 * (the 2.x note) and "checked against your sources" for grounded ones.
 * @param {HTMLElement} el
 * @param {NodeRecord} node
 */
function labelAnswer(el, node) {
  const custom = single.label?.(node) ?? null;
  const slot = el.querySelector('.message-provenance');
  if (custom && slot) {
    slot.insertAdjacentHTML('afterbegin', html`${provenanceBadge(custom.kind, custom.labelKey ? { label: custom.labelKey } : {})}`.value);
    refreshIcons(slot);
    return;
  }
  const route = metaOf(node).chat_mode ?? node.label;
  if (route === 'free') markFreeAnswer(el);
  else if (route === 'grounded' && slot) {
    slot.insertAdjacentHTML('afterbegin', html`${provenanceBadge('checked', { className: 'mt-2' })}`.value);
    refreshIcons(slot);
  }
}

/** Stop reasons that leave a note under the answer (the others end normally or show a notice). */
const STOP_NOTES = new Set(['max_tokens', 'refusal', 'cancelled', 'timeout']);

/**
 * What else an answer shows: why it stopped early, the web pages it cites (from the provider's
 * search, as links), and a provider's search suggestions in the isolated grounding frame.
 * @param {HTMLElement} el
 * @param {NodeRecord} node
 */
function decorateAnswer(el, node) {
  const slot = el.querySelector('.message-provenance');
  if (!slot) return;
  const meta = metaOf(node);
  if (STOP_NOTES.has(meta.stop_reason)) {
    const note = document.createElement('p');
    note.className = 'stop-note mt-2 text-[11px] text-slate-600';
    setText(note, `ai.stop.${meta.stop_reason}`);
    slot.append(note);
  }
  const sources = Array.isArray(meta.web_sources) ? meta.web_sources.filter((w) => w && typeof w.url === 'string' && /^https?:\/\//i.test(w.url)) : [];
  if (sources.length) {
    const row = document.createElement('div');
    row.className = 'web-sources mt-2 flex flex-wrap items-center gap-1.5 text-[11px]';
    const label = document.createElement('span');
    label.className = 'text-slate-500 font-medium';
    setText(label, 'chat-thread.web.sources');
    row.append(label);
    for (const w of sources) {
      const a = document.createElement('a');
      a.href = w.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'badge badge-muted max-w-[16rem] truncate underline';
      a.textContent = typeof w.title === 'string' && w.title.trim() ? w.title.trim() : new URL(w.url).host;
      row.append(a);
    }
    slot.append(row);
  }
  for (const o of node.opaque ?? []) {
    const block = /** @type {any} */ (o)?.block;
    if (block?.kind === 'gemini-grounding' && typeof block.searchEntryPoint === 'string' && block.searchEntryPoint) {
      const host = document.createElement('div');
      host.className = 'search-suggestions mt-2';
      slot.append(host);
      mountGroundingFrame(host, block.searchEntryPoint, { title: t('chat-thread.web.suggestions') });
    }
  }
}

/**
 * The web pages an answer cites, once each (at most eight).
 * @param {CompletionResult} result
 */
function webSources(result) {
  /** @type {Array<{ url: string, title: string }>} */
  const out = [];
  for (const c of result.citations) {
    if (!/^https?:\/\//i.test(c.url) || out.some((w) => w.url === c.url)) continue;
    out.push({ url: c.url.slice(0, 2000), title: String(c.title ?? '').slice(0, 200) });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * The chips of a message's attachments.
 * @param {NodeRecord} node
 */
function chipsOf(node) {
  return node.parts.filter((p) => p.type === 'image' || p.type === 'file').map((p) => ({ name: String(p.name ?? ''), kind: /** @type {'image' | 'file'} */ (p.type === 'image' ? 'image' : 'file') }));
}

/**
 * The bar state of a message.
 * @param {NodeRecord} node
 */
function barState(node) {
  const branch = current ? branchInfo(current.tree, node.id) : null;
  const meta = metaOf(node);
  const canContinue = node.role === 'assistant' && meta.stop_reason === 'max_tokens' && (meta.chat_mode ?? node.label) === 'free' && leafId() === node.id;
  return { node, branch: branch ? { position: branch.position, count: branch.count } : null, canContinue, busy };
}

/** Re-renders the action bars of the messages on screen (busy state, branches, Continue). */
function refreshBars() {
  if (!current) return;
  for (const el of document.querySelectorAll('#chatMessages .message-row[data-node-id]')) {
    const node = current.tree.byId.get(/** @type {HTMLElement} */ (el).dataset.nodeId ?? '');
    if (node) renderActions(/** @type {HTMLElement} */ (el), barState(node));
  }
}

/**
 * Shows one stored message.
 * @param {NodeRecord} node
 * @returns {HTMLElement | null}
 */
function renderNode(node) {
  const meta = metaOf(node);
  if (node.role === 'user') {
    if (meta.continue) {
      const row = document.createElement('div');
      row.className = 'message-row continue-marker w-full max-w-4xl mx-auto flex items-center gap-2 text-[11px] text-slate-500';
      row.dataset.nodeId = node.id;
      row.dataset.role = 'user';
      const line = document.createElement('span');
      line.className = 'flex-1 border-t border-dashed border-slate-300';
      const label = document.createElement('span');
      label.dataset.i18n = 'chat-thread.continued';
      label.textContent = t('chat-thread.continued');
      row.append(line.cloneNode(), label, line);
      document.getElementById('chatMessages')?.append(row);
      return row;
    }
    const el = appendMessage('user', nodeText(node), { nodeId: node.id, attachments: chipsOf(node) });
    renderActions(el, barState(node));
    return el;
  }
  if (node.role !== 'assistant') return null;
  const route = meta.chat_mode ?? node.label;
  const el = appendMessage('assistant', nodeText(node), {
    nodeId: node.id,
    ...answerBadge(node),
    sources: node.sources,
    reasoning: typeof meta.reasoning === 'string' ? meta.reasoning : undefined,
    trace: typeof meta.thoughts === 'string' ? meta.thoughts : null,
    durationMs: typeof meta.duration_ms === 'number' ? meta.duration_ms : null,
    traceRoles: route === 'free' ? FREE_TRACE_ROLES : undefined,
    meta: metaLine(node),
  });
  labelAnswer(el, node);
  decorateAnswer(el, node);
  renderActions(el, barState(node));
  return el;
}

/**
 * Removes the messages on screen from this node on (a regenerated answer or an edited question
 * replaces them).
 * @param {string} nodeId
 */
function removeFrom(nodeId) {
  const box = document.getElementById('chatMessages');
  const row = box?.querySelector(`.message-row[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!box || !row) return;
  let next = row;
  while (next) {
    const after = next.nextElementSibling;
    next.remove();
    next = /** @type {Element} */ (after);
  }
}

/**
 * Shows a stored conversation: its active path. Notices shown since the page started (when this is
 * the first load) stay below it.
 * @param {string} [id] default: the current chat session
 * @param {{ keepNotices?: boolean }} [opts]
 */
export async function showConversation(id = currentSessionId(), opts = {}) {
  const seq = ++showSeq;
  conversationId = id;
  /** @type {Thread | null} */
  let loaded = null;
  try {
    loaded = await (await store()).loadThread(id);
  } catch (err) {
    console.warn('[starpi] could not load the conversation', err);
  }
  if (seq !== showSeq) return;
  current = loaded;
  const box = document.getElementById('chatMessages');
  const shownSinceBoot = opts.keepNotices && box ? [...box.children].slice(1).filter((el) => !(el instanceof HTMLElement && el.dataset.nodeId)) : [];
  resetMessages();
  for (const node of current?.path ?? []) renderNode(node);
  box?.append(...shownSinceBoot);
}

/** Clears the thread on screen (a new chat). */
export function resetThread() {
  conversationId = currentSessionId();
  current = null;
  ++showSeq;
  resetMessages();
  setAssistantStatus('status.ready');
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * A stored blob as base64 (cached for the page).
 * @param {string} blobId
 */
async function blobBase64(blobId) {
  const key = `b64:${blobId}`;
  const cached = blobData.get(key);
  if (cached !== undefined) return cached;
  const record = await (await store()).getBlob(blobId);
  const data = record ? await blobToBase64(record.data) : '';
  blobData.set(key, data);
  return data;
}

/**
 * The text of a stored file attachment (plain text read, documents and PDFs extracted), cached.
 * @param {StoredPart} part
 */
async function blobText(part) {
  const blobId = String(part.blobId ?? '');
  const key = `txt:${blobId}`;
  const cached = blobData.get(key);
  if (cached !== undefined) return cached;
  const record = await (await store()).getBlob(blobId);
  let text = '';
  if (record) {
    try {
      text =
        part.kind === 'text'
          ? await record.data.text()
          : await attachmentText({ id: blobId, name: String(part.name ?? 'file'), kind: part.kind === 'pdf' ? 'pdf' : 'document', mime: record.type, blob: record.data, file: /** @type {File} */ (record.data) });
    } catch (err) {
      console.warn('[starpi] an attached file could not be read', err);
    }
  }
  blobData.set(key, text);
  return text;
}

/**
 * The text of attachments within a budget: a file that does not fit is cut (always at the same
 * place for the same model, so a replayed turn stays the same).
 * @param {string} text
 * @param {number} room
 */
function fitText(text, room) {
  return text.length <= room ? text : cutFenced(text, Math.max(0, room));
}

/**
 * A stored question as a message for one model: its context block (free questions), its
 * attachments as the model can take them, and its text.
 * @param {NodeRecord} node
 * @param {Target} target
 * @param {Caps} caps
 * @returns {Promise<Message>}
 */
async function userMessage(node, target, caps) {
  const meta = metaOf(node);
  const locale = getLocale();
  /** @type {Part[]} */
  const content = [];
  if (typeof meta.context === 'string' && meta.context) content.push({ type: 'text', text: meta.context });
  let room = textBudget(caps);
  for (const p of node.parts) {
    if (p.type === 'image' && typeof p.blobId === 'string') {
      if (caps.vision) content.push({ type: 'image', mime: /** @type {import('../ai/contract.js').ImageMime} */ (p.mime ?? 'image/jpeg'), data: await blobBase64(p.blobId), name: String(p.name ?? '') });
      else content.push({ type: 'text', text: `[${String(p.name ?? 'image')}]` });
    } else if (p.type === 'file' && typeof p.blobId === 'string') {
      const size = typeof p.size === 'number' ? p.size : 0;
      if (p.kind === 'pdf' && caps.pdf && target.route !== 'pool' && size <= MAX_NATIVE_PDF_BYTES) {
        content.push({ type: 'file', mime: 'application/pdf', data: await blobBase64(p.blobId), name: String(p.name ?? 'document') });
      } else {
        const text = fitText(await blobText(p), room);
        room -= text.length;
        content.push({ type: 'text', text: attachmentSection(locale, { name: String(p.name ?? 'file'), text }) });
      }
    }
  }
  const text = nodeText(node);
  if (text) content.push({ type: 'text', text });
  return { role: 'user', content };
}

/**
 * A stored answer as a message: its text and, for free answers, its provider state, replayed
 * unchanged (the adapters drop state another provider wrote).
 * @param {NodeRecord} node
 * @returns {Message}
 */
function assistantMessage(node) {
  const free = (metaOf(node).chat_mode ?? node.label) !== 'grounded';
  /** @type {Part[]} */
  const content = [{ type: 'text', text: nodeText(node) }];
  if (free) for (const o of node.opaque ?? []) if (o && typeof o === 'object' && /** @type {any} */ (o).type === 'opaque') content.push(/** @type {Part} */ (o));
  return { role: 'assistant', content };
}

/**
 * The turns of a path a model may get: questions answered on this device stay on it for every
 * model that is not on this device too.
 * @param {NodeRecord[]} path
 * @param {Target} target
 */
function shareable(path, target) {
  const onDevice = target.route === 'device' || target.route === 'local';
  if (onDevice) return path;
  return path.filter((node, i) => !node.localOnly && !(node.role === 'user' && path[i + 1]?.localOnly));
}

/**
 * Whether the conversation holds a compaction block of the server (it then must keep compacting).
 * @param {NodeRecord[]} path
 */
function hasCompaction(path) {
  return path.some((n) => (n.opaque ?? []).some((o) => JSON.stringify(/** @type {any} */ (o)?.block ?? null).includes('"type":"compaction"')));
}

/**
 * The output limit of a free answer for a model.
 * @param {Target} target
 * @param {Caps} caps
 */
function answerTokens(target, caps) {
  if (target.route === 'device') return undefined;
  if (target.route === 'pool') return Math.min(caps.maxOutput || 4096, 4096);
  if (target.route === 'local') return Math.min(caps.maxOutput || SERVER_ANSWER_TOKENS, SERVER_ANSWER_TOKENS);
  return Math.min(caps.maxOutput || CLOUD_ANSWER_TOKENS, CLOUD_ANSWER_TOKENS);
}

/**
 * The free request for one model: the stable system prompt, the history (whole for Anthropic,
 * within the model's context for the others, within the pool's limits on the site's pools) and the
 * question.
 * @param {Target} target
 * @param {NodeRecord[]} path  the active path ending with the question
 * @param {TurnContext} ctx
 * @returns {Promise<AiRequest>}
 */
async function freeRequest(target, path, ctx) {
  const caps = capsOf(target.provider, target.model);
  const locale = getLocale();
  const who = target.route === 'device' ? 'local' : target.route === 'local' ? 'server' : 'cloud';
  const notes = [...systemNoteHooks].map((fn) => fn(ctx)).filter(Boolean);
  const system = [freeSystemPrompt(who, locale), ...notes].join('\n\n');
  const turns = shareable(path, target);
  /** @type {Message[]} */
  const messages = [];
  for (const node of turns) {
    if (node.role === 'user') messages.push(await userMessage(node, target, caps));
    else if (node.role === 'assistant') messages.push(assistantMessage(node));
  }
  const question = /** @type {Message} */ (messages.pop());
  let history = messages;
  const maxOutputTokens = answerTokens(target, caps);
  if (target.provider !== 'anthropic') {
    const budget = caps.contextTokens - (maxOutputTokens ?? Math.floor(caps.contextTokens / 2)) - estimateTokens(system) - estimateTokens(question) - 256;
    history = trimHistory(history, Math.max(0, budget));
  }
  /** @type {AiRequest} */
  let req = { provider: target.provider, model: target.model, system, messages: [...history, question], temperature: 0.7, ...(maxOutputTokens ? { maxOutputTokens } : {}) };
  if (getWebSearch() && caps.search !== 'none' && target.route !== 'pool') req.search = { enabled: true };
  req = applyThinking(req, thinkingFor({ provider: target.provider, model: target.model, caps, show: true }));
  if (target.route === 'pool') {
    const fitted = fitPoolRequest({ system: req.system, messages: req.messages });
    req = { ...req, system: fitted.system, messages: fitted.messages };
  }
  for (const hook of requestHooks) req = hook(req, ctx);
  return req;
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} StreamView
 * @property {ReturnType<typeof createStreamingMessage>} stream
 * @property {() => string} text
 * @property {() => string} reasoning
 * @property {ChatAttempt[]} attempts
 */

/**
 * Streams one answer into a new bubble.
 * @param {Target[]} candidates
 * @param {(target: Target) => Promise<AiRequest>} build
 * @param {AbortSignal} signal
 * @param {{ before?: Element | null }} [placement]
 */
async function streamAnswer(candidates, build, signal, placement = {}) {
  const stream = createStreamingMessage('', undefined, placement);
  let text = '';
  let reasoning = '';
  const run = await runAnswer({
    candidates,
    signal,
    build,
    onStart: (target, served) => {
      stream.setBadge(...badgeArgs(target, served));
      const badge = document.getElementById('servedModel');
      if (badge) {
        setText(badge, 'chat-thread.picker.served', { model: `${providerLabel(target.provider)} · ${modelLabel(target.provider, served || target.model)}` });
        badge.classList.remove('hidden');
      }
    },
    onEvent: (ev) => {
      if (ev.type === 'text') {
        text += ev.delta;
        stream.update(text);
      } else if (ev.type === 'reasoning' && typeof ev.delta === 'string') {
        reasoning += ev.delta;
        stream.reasoning(reasoning);
      }
    },
    adapterFor: (target, req) => (target.provider === 'anthropic' && (estimateTokens(JSON.stringify(req.messages)) > COMPACTION_TOKENS || hasCompaction(current?.path ?? [])) ? compactingAnthropic() : undefined),
  });
  return { stream, run };
}

/**
 * The badge of a streaming answer once its model is known.
 * @param {Target} target
 * @param {string} served
 * @returns {[string, Record<string, string>]}
 */
function badgeArgs(target, served) {
  const b = answerBadge({ provider: target.provider, model: served || target.model, meta: { requested: target.model, route: target.route } });
  return [b.badge, b.badgeParams ?? {}];
}

/**
 * Says why there is no answer: the error's text from i18n only, never the provider's own words.
 * @param {CompletionResult} result
 * @param {boolean} free
 */
function noticeFor(result, free) {
  const code = result.error?.code ?? (result.stopReason === 'refusal' ? 'refusal' : 'bad_response');
  if (code === 'aborted') return;
  const seconds = result.error?.retryAfterMs ? Math.ceil(result.error.retryAfterMs / 1000) : 0;
  appendNotice({
    icon: code === 'refusal' ? 'info' : 'triangle-alert',
    tone: code === 'refusal' ? 'info' : 'warn',
    title: free ? 'chat.provider_failed_title' : 'chat-thread.notice.grounded_failed_title',
    body: seconds ? (code === 'rate_limited' ? 'chat-thread.notice.rate_limited_wait' : 'chat-thread.notice.error_retry') : `ai.error.${code}`,
    params: { reason: t(`ai.error.${code}`), seconds },
  });
}

/**
 * A note for the details about how the answer came about: other models tried before, the served
 * model, a stop before the end.
 * @param {ChatAttempt[]} attempts
 * @param {CompletionResult} result
 */
function attemptNote(attempts, result) {
  const failed = attempts.filter((a) => a.outcome !== 'ok' && a.outcome !== 'truncated' && a.outcome !== 'refused');
  const parts = failed.map((a) => `${providerLabel(a.provider)} ${modelLabel(a.provider, a.model)}: ${t(`ai-orchestration.outcome.${a.outcome}`)}`);
  const stop = result.stopReason === 'max_tokens' || result.stopReason === 'cancelled' || result.stopReason === 'timeout' ? t(`ai.stop.${result.stopReason}`) : '';
  return [...parts, stop].filter(Boolean).join(' · ') || undefined;
}

/**
 * The usage of an answer as the store keeps it.
 * @param {CompletionResult} result
 */
function usageOf(result) {
  if (!result.usage) return null;
  const u = result.usage;
  return { input: u.input, output: u.output, ...(u.reasoning ? { reasoning: u.reasoning } : {}), ...(u.cacheRead ? { cacheRead: u.cacheRead } : {}), ...(typeof u.costUsd === 'number' ? { costUsd: u.costUsd } : {}) };
}

/**
 * The engine id of an answer (exports and the 2.x labels read it).
 * @param {Target} target
 */
function engineOf(target) {
  if (target.provider === 'webgpu') return 'client';
  if (target.provider === 'wasm') return 'wasm';
  if (target.route === 'local') return 'local';
  return target.route === 'pool' ? 'pool' : 'cloud';
}

/**
 * Makes sure the conversation exists in the store.
 * @param {ChatStore} db
 * @param {'free' | 'grounded'} route
 */
async function ensureConversation(db, route) {
  const existing = await db.getConversation(conversationId);
  if (existing) {
    void db.updateConversation(conversationId, { mode: getChatMode(), model: getAssistant() }).catch(() => {});
    return existing;
  }
  return db.createConversation({ id: conversationId, mode: route === 'grounded' && getChatMode() === 'grounded' ? 'grounded' : getChatMode(), model: getAssistant() });
}

/**
 * Stores a question with its attachments (as blobs owned by it).
 * @param {{ text: string, attachments: PreparedAttachment[], parentId: string | null, route: 'free' | 'grounded', localOnly: boolean, context?: string, continueOf?: boolean, reuseParts?: StoredPart[] }} q
 * @returns {Promise<NodeRecord>}
 */
async function storeQuestion(q) {
  const db = await store();
  await ensureConversation(db, q.route);
  const id = crypto.randomUUID();
  /** @type {StoredPart[]} */
  const parts = [...(q.reuseParts ?? [])];
  for (const att of q.attachments) {
    const blobId = await db.putBlob(att.blob, { kind: 'attachment', name: att.name, ownerId: id });
    if (att.kind === 'image') parts.push({ type: 'image', mime: att.mime, blobId, name: att.name, ...(att.width ? { width: att.width, height: att.height } : {}) });
    else parts.push({ type: 'file', mime: att.mime, blobId, name: att.name, kind: att.kind, size: att.blob.size });
    if (typeof att.text === 'string') blobData.set(`txt:${blobId}`, att.text);
    else if (att.docId) {
      // The workspace already read the file: its text is taken from there, not parsed again.
      try {
        blobData.set(`txt:${blobId}`, (await getDocumentText(att.docId)).text);
      } catch {
        // read from the blob when a model needs it
      }
    }
  }
  parts.push({ type: 'text', text: q.text });
  /** @type {Record<string, unknown>} */
  const meta = { chat_mode: q.route };
  if (q.context) meta.context = q.context;
  if (q.continueOf) meta.continue = true;
  const node = await db.appendNode(conversationId, { id, parentId: q.parentId, role: 'user', parts, localOnly: q.localOnly, meta });
  await reload();
  return node;
}

/**
 * Asks for a short title after the first answer of a conversation that still has the automatic
 * one; the first words of the question stay when no model names it.
 * @param {string} question
 * @param {string} answer
 * @param {boolean} localOnly  the conversation stays on this device: only the model here may name it
 */
async function nameConversation(question, answer, localOnly) {
  const db = await store();
  const conversation = await db.getConversation(conversationId);
  const { titleFromText } = await import('./store.js');
  if (!conversation || conversation.title !== titleFromText(question)) return;
  try {
    const { runPurpose } = await import('../ai/router.js');
    const r = await runPurpose('title_chat', { messages: [{ role: 'user', text: question }, { role: 'assistant', text: answer.slice(0, 1500) }] }, { cache: 'off', signal: AbortSignal.timeout(TIMEOUTS_MS.chatTitle), ...(localOnly ? { providers: [] } : {}) });
    if (!r.ok || r.tier === 'template' || !r.text) return;
    const now = await db.getConversation(conversationId);
    if (now && now.title === conversation.title) await db.updateConversation(conversationId, { title: r.text });
  } catch {
    // The automatic title stays.
  }
}

/**
 * Answers the question at the end of the active path in the free route.
 * @param {NodeRecord} question
 * @param {AssistantValue} value
 * @param {AbortSignal} signal
 * @param {{ before?: Element | null }} [placement]
 */
async function answerFree(question, value, signal, placement = {}) {
  const started = performance.now();
  const hasImages = needsVision(question.parts.map((p) => ({ kind: p.type === 'image' ? 'image' : 'file' })));
  let candidates = await chatCandidates(value, { vision: hasImages });
  if (!candidates.length && value === 'device' && !signal.aborted && (await startLocalEngine({ interactive: true }))) candidates = await chatCandidates(value, { vision: hasImages });
  if (!candidates.length) {
    appendNotice({ icon: 'info', tone: 'info', title: 'chat.free_no_model_title', body: hasImages ? 'chat-thread.notice.no_vision_model' : 'chat-thread.notice.no_model_body' });
    return null;
  }
  const path = current?.path ?? [question];
  /** @type {TurnContext} */
  const ctx = { conversationId, question: nodeText(question), mode: getChatMode(), route: 'free', target: candidates[0], locale: getLocale(), attachments: chipsOf(question) };
  const { stream, run } = await streamAnswer(candidates, (target) => freeRequest(target, path, ctx), signal, placement);
  let { result } = run;
  // Tool calls an answer stopped for go to the registered runner, which returns the answer after them.
  if (result.stopReason === 'tool_call' && single.tools && run.target && !signal.aborted) {
    const after = await single.tools({ result, request: await freeRequest(run.target, path, ctx), ctx, signal }).catch(() => null);
    if (after) result = after;
  }
  const text = result.text;
  const durationMs = Math.round(performance.now() - started);
  if (!text.trim() || !run.target) {
    stream.remove();
    if (!signal.aborted) noticeFor(result, true);
    return null;
  }
  const target = run.target;
  const note = attemptNote(run.attempts, result);
  const badge = answerBadge({ provider: target.provider, model: result.model, meta: { requested: target.model, route: target.route } });
  const trace = describeChatTrace({ engineLabel: t(badge.badge, badge.badgeParams), durationMs, attachment: chipsOf(question).map((c) => c.name).join(', ') || null, note });
  const db = await store();
  const node = await db.appendNode(conversationId, {
    parentId: question.id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    opaque: result.opaque,
    model: result.model,
    provider: result.provider,
    label: 'free',
    usage: usageOf(result),
    localOnly: target.route === 'device' || question.localOnly,
    meta: {
      engine: engineOf(target),
      chat_mode: 'free',
      requested: target.model,
      route: target.route,
      duration_ms: durationMs,
      stop_reason: signal.aborted ? 'cancelled' : result.stopReason,
      thoughts: trace,
      ...(result.reasoning ? { reasoning: result.reasoning.slice(0, REASONING_CHARS) } : {}),
      ...(run.continued ? { continued: run.continued } : {}),
      ...(result.citations.length ? { web_sources: webSources(result) } : {}),
      ...(run.attempts.length > 1 ? { attempts: run.attempts.map((a) => ({ provider: a.provider, model: a.model, outcome: a.outcome, ...(a.code ? { code: a.code } : {}) })) } : {}),
    },
  });
  await reload();
  stream.element.dataset.nodeId = node.id;
  stream.finalize(text, { citations: null, trace, durationMs, traceRoles: FREE_TRACE_ROLES, reasoning: result.reasoning, meta: metaLine(node) });
  labelAnswer(stream.element, node);
  decorateAnswer(stream.element, node);
  if (result.error && !signal.aborted) noticeFor(result, true);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Grounded answers
// ---------------------------------------------------------------------------------------------

async function knownTitles() {
  if (titlesCache && Date.now() - titlesCache.at < 60_000) return titlesCache.titles;
  if (getConnection().status === 'offline') return [];
  const res = await listDocuments();
  if (!res.ok) return []; // unknown, not empty: never cached
  const titles = res.data.map((d) => d.title);
  titlesCache = { at: Date.now(), titles };
  return titles;
}

/**
 * Workspace chunks for the question; just-attached files always contribute (their best chunks, or
 * their first chunks when nothing in them matches, e.g. "summarize this file") and come first.
 * @param {string} query
 * @param {string[]} focus  ids of the files attached to this question
 * @returns {Promise<{ hits: KnowledgeHit[], pinned: number }>}
 */
async function retrieveWorkspace(query, focus) {
  try {
    const found = await searchWorkspace(query, LIMITS.retrievalRows);
    if (!focus.length) return { hits: found.map(workspaceHit), pinned: 0 };
    /** @type {any[]} */
    const pinned = [];
    for (const docId of focus) {
      const inFile = found.filter((h) => h.docId === docId);
      pinned.push(...(inFile.length ? inFile.slice(0, 3) : await firstChunks(docId, 3)));
    }
    const others = found.filter((h) => !focus.includes(h.docId));
    return { hits: [...pinned, ...others].map(workspaceHit), pinned: pinned.length };
  } catch (err) {
    console.warn('[starpi] workspace search failed', err);
    return { hits: [], pinned: 0 };
  }
}

/**
 * The excerpts for a grounded question: the workspace, and the knowledge base (searched with the
 * question, or for a question that stays on this device ranked here without sending it).
 * @param {string} query
 * @param {string[]} focus
 * @param {{ workspaceOnly: boolean, deviceOnly: boolean }} opts
 * @returns {Promise<{ hits: KnowledgeHit[], method: string, kbUnavailable: boolean }>}
 */
async function retrieve(query, focus, opts) {
  const { hits: local, pinned } = await retrieveWorkspace(query, focus);
  const limit = LIMITS.retrievalRows + Math.min(focus.length * 3, 9);
  const merge = (/** @type {KnowledgeHit[]} */ remote) => mergeHits(local, remote, limit, pinned);
  const result = (/** @type {KnowledgeHit[]} */ hits, /** @type {string} */ remote, /** @type {boolean} */ kbUnavailable) => {
    const n = hits.filter((h) => h.workspace).length;
    return { hits, method: [n ? t('retrieval.workspace', { n }) : '', remote].filter(Boolean).join(' + '), kbUnavailable };
  };
  if (opts.workspaceOnly) return result(local.slice(0, limit), '', false);
  // While Supabase is known to be unreachable, answer from the workspace at once.
  if (getConnection().status === 'offline') return result(merge([]), t('retrieval.offline'), true);
  if (!opts.deviceOnly) {
    const search = await searchKnowledge(query);
    if (search.ok && search.data.length > 0) return result(merge(search.data), t('retrieval.fts'), false);
    const recent = await recentKnowledge(30);
    const why = search.ok ? 'retrieval.why_no_match' : search.error.kind === 'missing_function' ? 'retrieval.why_missing' : 'retrieval.why_unavailable';
    if (!recent.ok) return result(merge([]), t('retrieval.offline'), true);
    return result(merge(rankHitsLocally(query, recent.data, LIMITS.retrievalRows)), t('retrieval.keyword', { why: t(why) }), false);
  }
  // On this device: the library ranked by the question's vector made here, else candidates fetched
  // without the question and ranked in the browser.
  const byMeaning = await libraryHitsByMeaning(query, LIMITS.retrievalRows);
  if (byMeaning?.length) return result(merge(byMeaning), t('workspace.retrieval_vector'), false);
  const recent = await recentKnowledge(30);
  const ranked = recent.ok ? rankHitsLocally(query, recent.data, LIMITS.retrievalRows) : [];
  return result(merge(ranked), t(recent.ok ? 'retrieval.local' : 'retrieval.offline'), !recent.ok);
}

/**
 * Adds the files of a grounded question to the workspace (an image only after the user agreed to
 * have its text recognised by a model that reads images). Returns their document ids.
 * @param {PreparedAttachment[]} attachments
 * @returns {Promise<string[]>}
 */
async function addToSources(attachments) {
  /** @type {string[]} */
  const ids = [];
  for (const att of attachments) {
    if (att.docId) {
      ids.push(att.docId);
      continue;
    }
    try {
      /** @type {import('../rag/workspace.js').OcrHook | undefined} */
      let ocr;
      if (att.kind === 'image') {
        const { ocrAvailable, ocrHook } = await import('../rag/ocr-hook.js');
        if (!(await ocrAvailable()) || !window.confirm(t('workspace.ocr_confirm', { name: att.name }))) {
          appendNotice({ icon: 'info', tone: 'info', title: 'chat-thread.notice.image_not_source', params: { name: att.name } });
          continue;
        }
        ocr = ocrHook();
      }
      const doc = await addToWorkspace(att.file, ocr ? { ocr } : {});
      ids.push(doc.docId);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
      appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'workspace.error_title', body: `workspace.error_${['unsupported_type', 'too_large', 'empty', 'invalid_json', 'invalid_pdf', 'encrypted_pdf', 'pdf_reader', 'worker_crashed', 'cleared'].includes(code) ? code : 'internal'}`, params: { name: att.name } });
    }
  }
  return ids;
}

/**
 * The grounded request for one model. On this device the instructions, excerpts, history and
 * question are budgeted into the loaded model's context; on the site's pools they are fitted to the
 * pool's limits. `delivered` receives the context that actually went out (the source check
 * compares with it).
 * @param {Target} target
 * @param {{ question: string, context: string, history: NodeRecord[], delivered: { context: string } }} input
 * @returns {Promise<AiRequest>}
 */
async function groundedRequest(target, input) {
  const locale = getLocale();
  const caps = capsOf(target.provider, target.model);
  const turns = historyWindow(
    shareable(input.history, target)
      .filter((n) => n.role === 'user' || n.role === 'assistant')
      .map((n) => ({ role: /** @type {'user' | 'assistant'} */ (n.role), content: nodeText(n) })),
    GROUNDED_WINDOW,
  );
  if (target.route === 'device') {
    const model = getEngineState().model;
    const maxTokens = model ? await (await import('../models/bench-rates.js')).localAnswerTokens(model, { free: false }) : 512;
    const budget = budgetPrompt({
      contextWindow: model?.chatOptions.context_window_size ?? caps.contextTokens,
      maxOutputTokens: maxTokens,
      system: buildInstructions(locale, 'local'),
      context: input.context,
      history: turns,
      user: input.question,
    });
    input.delivered.context = budget.context;
    return {
      provider: target.provider,
      model: target.model,
      system: `${budget.system}\n\n${contextSection(locale, budget.context)}`,
      messages: [...budget.history.map((h) => ({ role: h.role, content: [{ type: /** @type {const} */ ('text'), text: h.content }] })), { role: 'user', content: [{ type: 'text', text: budget.user }] }],
      maxOutputTokens: maxTokens,
      temperature: 0.2,
    };
  }
  const system = buildSystemPrompt({ locale, target: target.route === 'local' ? 'server' : 'cloud', context: input.context });
  /** @type {AiRequest} */
  let req = {
    provider: target.provider,
    model: target.model,
    system,
    messages: [...turns.map((h) => ({ role: h.role, content: [{ type: /** @type {const} */ ('text'), text: h.content }] })), { role: 'user', content: [{ type: 'text', text: input.question }] }],
    temperature: 0.2,
    maxOutputTokens: answerTokens(target, caps),
  };
  req = applyThinking(req, thinkingFor({ provider: target.provider, model: target.model, caps, show: true }));
  if (target.route === 'pool') {
    const fitted = fitPoolRequest({ system: req.system, messages: req.messages });
    req = { ...req, system: fitted.system, messages: fitted.messages };
  }
  input.delivered.context = req.system === system ? input.context : (req.system ?? '');
  return req;
}

/**
 * The gate's counts for a receipt: how many units of the answer the sentence gate released in
 * sources mode and how many it withheld.
 * @param {string} answer
 * @param {Array<{ label: string, text: string }>} sources
 */
async function gateCounts(answer, sources) {
  try {
    const { checkText } = await import('../core/gate.js');
    const r = checkText(answer, { mode: 'sources', sources: sources.map((s, i) => ({ index: i, label: s.label, text: s.text })) });
    return { mode: /** @type {const} */ ('sources'), released: r.released.length, withheld: r.withheld?.length ?? 0 };
  } catch (err) {
    console.warn('[starpi] the sentence gate could not judge the answer', err);
    return null;
  }
}

/**
 * Answers a grounded question: retrieval, an answer from the model (or quoted from the sources),
 * the source check and a receipt draft, for every model.
 * @param {{ text: string, attachments: PreparedAttachment[], parentId: string | null, value: AssistantValue, workspaceOnly: boolean, question?: NodeRecord }} q
 * @param {AbortSignal} signal
 * @param {{ before?: Element | null }} [placement]
 */
async function answerGrounded(q, signal, placement = {}) {
  const started = performance.now();
  // The question shows at once; it is stored once retrieval shows whether it stays on this device.
  const pending = q.question ? null : appendMessage('user', q.text, { attachments: q.attachments.map((a) => ({ name: a.name, kind: a.kind === 'image' ? 'image' : 'file' })) });
  const removeLoading = appendLoading('chat.thinking');
  try {
    const focus = await addToSources(q.attachments);
    const deviceOnly = q.value === 'device';
    const { hits, method, kbUnavailable } = await retrieve(q.text, focus, { workspaceOnly: q.workspaceOnly, deviceOnly });
    const greeting = !q.attachments.length && isGreeting(q.text);
    const used = greeting ? [] : hits;
    const usesWorkspace = used.some((h) => h.workspace);
    // The question follows its answer's storage rule: about the workspace (or on this device), it stays here.
    const question = q.question ?? (await storeQuestion({ text: q.text, attachments: q.attachments, parentId: q.parentId, route: 'grounded', localOnly: deviceOnly || usesWorkspace }));
    if (pending) {
      pending.dataset.nodeId = question.id;
      renderActions(pending, barState(question));
    }
    const history = (current?.path ?? []).slice(0, -1);
    const citationList = assignCitations(used, { excerptChars: LIMITS.excerptChars });
    const scope = registerCitations(citationList);
    const sources = distinctSources(used);
    const context = buildContext(citationList, { maxChars: LIMITS.contextCharsCloud });
    const delivered = { context };

    const candidates = await chatCandidates(q.value);
    let text = '';
    let engine = 'synthesizer';
    /** @type {import('./runner.js').RunResult | null} */
    let run = null;
    /** @type {HTMLElement | null} */
    let messageEl = null;
    /** @type {string | undefined} */
    let failure;
    if (candidates.length) {
      removeLoading();
      const view = await streamAnswer(candidates, (target) => groundedRequest(target, { question: q.text, context, history, delivered }), signal, placement);
      run = view.run;
      text = run.result.text.trim() ? run.result.text : '';
      if (text && run.target) {
        // The receipt names who answered: this device, the own server, or the provider.
        engine = engineOf(run.target) === 'cloud' || engineOf(run.target) === 'pool' ? run.target.provider : engineOf(run.target);
        messageEl = view.stream.element;
        const badge = answerBadge({ provider: run.target.provider, model: run.result.model, meta: { requested: run.target.model, route: run.target.route } });
        const trace = describeTrace({ query: q.text, method, hits: used, engineLabel: t(badge.badge, badge.badgeParams), durationMs: Math.round(performance.now() - started), note: attemptNote(run.attempts, run.result) });
        view.stream.finalize(text, { citations: scope, trace, durationMs: Math.round(performance.now() - started), reasoning: run.result.reasoning });
      } else {
        view.stream.remove();
        if (run.result.error && run.result.error.code !== 'aborted') failure = t(`ai.error.${run.result.error.code}`).replace(/\.\s*$/, '');
      }
    }
    if (signal.aborted && !text) throw new DOMException('Aborted', 'AbortError');
    if (failure) appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.provider_failed_title', body: 'chat.provider_failed_body', params: { reason: failure } });
    const durationMs = Math.round(performance.now() - started);
    if (!text) {
      text = synthesizeAnswer({
        query: q.text,
        hits: used,
        citations: citationList,
        knownTitles: [...new Set([...listWorkspace().map((d) => d.name), ...(await knownTitles())])],
        modelAvailable: !failure && candidates.length > 0,
        kbUnavailable,
        focusName: q.attachments.find((a) => a.kind !== 'image')?.name ?? null,
      });
      const trace = describeTrace({ query: q.text, method, hits: used, engineLabel: t('engine.label_synthesizer'), durationMs });
      removeLoading();
      messageEl = appendMessage('assistant', text, { citations: scope, badge: 'engine.label_synthesizer', trace, durationMs });
    }
    const answerText = text;
    // An answer quoted without a model can list the files in the workspace: their names stay on this device.
    const namesWorkspace = engine === 'synthesizer' && listWorkspace().some((d) => answerText.includes(d.name));
    /** @type {any} */
    let report = null;
    /** @type {string | undefined} */
    let receiptId;
    if (messageEl && scope) {
      const coverage = engine === 'synthesizer' ? citationList.map((c) => ({ delivered: /** @type {const} */ ('full'), text: c.text })) : contextCoverage(citationList, delivered.context);
      report = applyGrounding(messageEl, {
        scope,
        sources: citationList.map((c, i) => ({ label: c.label, doc: c.doc, heading: c.heading, text: coverage[i].text, delivered: coverage[i].delivered })),
        // What the user said may be repeated without a source; the model's own earlier answers may not.
        given: [q.text, ...history.slice(-4).filter((h) => h.role === 'user').map((h) => nodeText(h))],
        citedOnly: engine === 'synthesizer',
      });
      const docs = new Map(listWorkspace().map((d) => [d.docId, d]));
      /** @type {import('../core/receipt.js').ReceiptDraft} */
      let draft = {
        createdAt: new Date().toISOString(),
        version: APP_VERSION,
        answer: { text: answerText, engine, locale: getLocale() },
        question: q.text,
        grounding: report,
        citations: citationList.map((c, i) => {
          const doc = c.span ? docs.get(c.span.docId) : undefined;
          return {
            label: c.label,
            doc: c.doc,
            heading: c.heading,
            source: c.source,
            delivered: coverage[i].delivered,
            deliveredChars: coverage[i].delivered === 'partial' && c.text.startsWith(coverage[i].text) ? coverage[i].text.length : undefined,
            text: c.text,
            truncated: c.truncated,
            documentId: c.source === 'knowledge' ? c.documentId : null,
            document: doc && { name: doc.name, kind: doc.kind, bytes: doc.bytes, fileSha256: doc.fileSha256, textSha256: doc.textSha256, textChars: doc.chars, pages: doc.pages, extractor: doc.extractor, chunker: doc.chunker },
            chunk: c.span ? { index: c.span.chunkIndex, start: c.span.start, end: c.span.end } : undefined,
          };
        }),
      };
      const gate = await gateCounts(answerText, citationList.map((c, i) => ({ label: c.label, text: coverage[i].text })));
      if (gate) draft.gate = gate;
      for (const hook of receiptHooks) {
        try {
          draft = await hook(draft, { answer: answerText, question: q.text });
        } catch (err) {
          console.warn('[starpi] a receipt hook failed', err);
        }
      }
      receiptId = storeReceiptDraft(draft);
      messageEl.querySelector('.message-provenance')?.append(receiptButton(receiptId));
      refreshIcons(messageEl);
    }
    const target = run?.target ?? null;
    const result = run?.result;
    const trace = describeTrace({ query: q.text, method, hits: used, engineLabel: target ? t(...badgeArgs(target, result?.model ?? target.model)) : t('engine.label_synthesizer'), durationMs, note: run && result ? attemptNote(run.attempts, result) : failure });
    const db = await store();
    const node = await db.appendNode(conversationId, {
      parentId: question.id,
      role: 'assistant',
      parts: [{ type: 'text', text: answerText }],
      opaque: target && result ? result.opaque : [],
      model: target && result ? result.model : null,
      provider: target && result ? result.provider : null,
      label: 'grounded',
      usage: target && result ? usageOf(result) : null,
      sources,
      localOnly: deviceOnly || usesWorkspace || namesWorkspace,
      ...(report ? { grounding: { algorithm: report.algorithm, counts: report.counts, crossLanguage: report.crossLanguage, skipped: report.skipped } } : {}),
      meta: {
        engine,
        chat_mode: 'grounded',
        thoughts: trace,
        duration_ms: durationMs,
        ...(target ? { requested: target.model, route: target.route, stop_reason: signal.aborted ? 'cancelled' : result?.stopReason } : {}),
        ...(result?.reasoning ? { reasoning: result.reasoning.slice(0, REASONING_CHARS) } : {}),
      },
    });
    await reload();
    if (messageEl) {
      messageEl.dataset.nodeId = node.id;
      labelAnswer(messageEl, node);
      decorateAnswer(messageEl, node);
    }
    return node;
  } finally {
    removeLoading();
  }
}

// ---------------------------------------------------------------------------------------------
// Sending, regenerating, editing, branches, Continue
// ---------------------------------------------------------------------------------------------

/**
 * Runs one turn with the busy state, Stop and error handling around it.
 * @param {(signal: AbortSignal) => Promise<unknown>} fn
 */
async function withTurn(fn) {
  controller = new AbortController();
  setBusy(true);
  try {
    await fn(controller.signal);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn('[starpi] the answer failed', err);
      appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.error_title', body: 'chat.error_body', params: { reason: err instanceof Error ? err.message : String(err) } });
    }
  } finally {
    controller = null;
    setBusy(false);
  }
}

/** Stops the answer being written; what arrived so far is kept. */
export function stopAnswer() {
  controller?.abort();
  interrupt();
}

/**
 * The context block of a free question: the date and time and the notes of registered features.
 * @param {TurnContext} ctx
 */
async function contextFor(ctx) {
  /** @type {string[]} */
  const notes = [];
  for (const hook of turnNoteHooks) {
    try {
      notes.push(...(await hook(ctx)));
    } catch (err) {
      console.warn('[starpi] a turn note hook failed', err);
    }
  }
  let timeZone;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  return turnContext({ locale: getLocale(), now: new Date(), timeZone, notes: notes.slice(0, 8) });
}

/**
 * Sends the composer's draft (or a given question).
 * @param {{ text?: string, chatMode?: 'grounded' | 'free', workspaceOnly?: boolean }} [options]
 *   text: a question from elsewhere (quick prompts); chatMode: answer it this way (the mode control
 *   switches along, so it shows what this question does)
 */
export async function sendQuestion(options = {}) {
  if (busy) {
    setAssistantStatus('status.busy');
    return;
  }
  busy = true;
  let draft;
  try {
    setAssistantStatus('status.reading_file');
    draft = options.text !== undefined ? { text: options.text.trim().slice(0, LIMITS.chatInputChars), attachments: [] } : await takeDraft();
  } finally {
    busy = false;
    setAssistantStatus('status.ready');
  }
  if (!draft.text && !draft.attachments.length) return;
  if (options.text === undefined) clearComposer();
  if (options.chatMode === 'grounded' && getChatMode() !== 'grounded') setChatMode('grounded');
  const mode = options.chatMode ?? getChatMode();
  const kinds = draft.attachments.map((a) => ({ name: a.name, kind: a.kind }));
  const value = getAssistant();
  const route =
    options.chatMode ??
    (await decideRoute({
      question: draft.text,
      mode,
      attachments: kinds,
      workspaceDocs: listWorkspace().length,
      knowledgeDocs: mode === 'auto' ? (await knownTitles()).length : 0,
      modelReady: mode !== 'auto' || value === 'device' || (await chatCandidates(value)).length > 0,
    }));
  const onlyImages = draft.attachments.length > 0 && draft.attachments.every((a) => a.kind === 'image');
  const text =
    draft.text ||
    (onlyImages ? t('chat-thread.describe_images', { n: draft.attachments.length }) : draft.attachments.length === 1 ? t('chat.summarize_file', { name: draft.attachments[0].name }) : t('chat-thread.summarize_files', { n: draft.attachments.length }));
  await withTurn(async (signal) => {
    if (route === 'grounded') {
      await answerGrounded({ text, attachments: draft.attachments, parentId: leafId(), value, workspaceOnly: options.workspaceOnly === true }, signal);
      return;
    }
    /** @type {TurnContext} */
    const ctx = { conversationId, question: text, mode, route: 'free', target: null, locale: getLocale(), attachments: kinds };
    const question = await storeQuestion({ text, attachments: draft.attachments, parentId: leafId(), route: 'free', localOnly: value === 'device', context: await contextFor(ctx) });
    renderNode(question);
    const answer = await answerFree(question, value, signal);
    if (answer && current?.path.length === 2) void nameConversation(text, nodeText(answer), answer.localOnly);
  });
}

/**
 * The picker value that asks the same model again.
 * @param {NodeRecord} node
 * @returns {AssistantValue}
 */
function sameModel(node) {
  if (node.provider === 'webgpu' || node.provider === 'wasm') return 'device';
  const meta = metaOf(node);
  if (node.provider && typeof meta.requested === 'string' && meta.requested) return /** @type {AssistantValue} */ (`${node.provider}:${meta.requested}`);
  return getAssistant();
}

/**
 * Regenerates an answer as a new branch beside it, with the same model or another one.
 * @param {string} nodeId
 * @param {string | null} value  a picker value, or null for the same model
 */
export async function regenerate(nodeId, value) {
  if (busy) return;
  const node = threadNode(nodeId);
  const question = node?.parentId ? threadNode(node.parentId) : null;
  if (!node || node.role !== 'assistant' || !question) return;
  const { parsePickerValue } = await import('../models/choices.js');
  const picked = value ? parsePickerValue(value) : null;
  const target = picked?.assistant ?? sameModel(node);
  const route = (metaOf(node).chat_mode ?? node.label) === 'grounded' ? 'grounded' : 'free';
  await withTurn(async (signal) => {
    const db = await store();
    // The path to the question is the thread now; the new answer becomes its newest child.
    await db.setActiveLeaf(conversationId, question.id);
    await reload();
    removeFrom(nodeId);
    let answer = null;
    try {
      answer = route === 'grounded' ? await answerGrounded({ text: nodeText(question), attachments: [], parentId: question.parentId, value: target, workspaceOnly: false, question }, signal) : await answerFree(question, target, signal);
    } finally {
      // No new answer: the one before stays the thread.
      if (!answer) {
        await db.setActiveLeaf(conversationId, nodeId);
        await reload();
        const old = threadNode(nodeId);
        if (old) renderNode(old);
      }
      refreshBars();
    }
  });
}

/**
 * Answers an edited question as a new branch beside the original (its attachments stay).
 * @param {string} nodeId
 * @param {string} text
 */
export async function editQuestion(nodeId, text) {
  if (busy) return;
  const node = threadNode(nodeId);
  if (!node || node.role !== 'user') return;
  const route = metaOf(node).chat_mode === 'grounded' ? 'grounded' : 'free';
  const value = getAssistant();
  await withTurn(async (signal) => {
    removeFrom(nodeId);
    if (route === 'grounded') {
      await answerGrounded({ text, attachments: [], parentId: node.parentId, value, workspaceOnly: false }, signal);
    } else {
      /** @type {TurnContext} */
      const ctx = { conversationId, question: text, mode: getChatMode(), route: 'free', target: null, locale: getLocale(), attachments: chipsOf(node) };
      const reuse = node.parts.filter((p) => p.type !== 'text');
      const question = await storeQuestion({ text, attachments: [], reuseParts: reuse, parentId: node.parentId, route: 'free', localOnly: node.localOnly, context: await contextFor(ctx) });
      renderNode(question);
      await answerFree(question, value, signal);
    }
    refreshBars();
  });
}

/**
 * Shows the previous or next branch at a message.
 * @param {string} nodeId
 * @param {number} delta
 */
export async function showBranch(nodeId, delta) {
  if (busy || !current) return;
  const leaf = switchBranch(current.tree, nodeId, delta);
  if (!leaf) return;
  await (await store()).setActiveLeaf(conversationId, leaf);
  await showConversation(conversationId);
}

/**
 * Continues an answer that stopped at its length limit: a new turn asks the same model to go on.
 * @param {string} nodeId
 */
export async function continueAnswer(nodeId) {
  if (busy) return;
  const node = threadNode(nodeId);
  if (!node || node.role !== 'assistant' || leafId() !== node.id) return;
  const value = sameModel(node);
  await withTurn(async (signal) => {
    /** @type {TurnContext} */
    const ctx = { conversationId, question: '', mode: getChatMode(), route: 'free', target: null, locale: getLocale(), attachments: [] };
    const question = await storeQuestion({ text: t('chat-thread.continue_prompt'), attachments: [], parentId: node.id, route: 'free', localOnly: node.localOnly, context: await contextFor(ctx), continueOf: true });
    renderNode(question);
    await answerFree(question, value, signal);
    refreshBars();
  });
}

/**
 * Whether the draft's attachments can go to the chosen model (the composer disables Send otherwise).
 * @param {readonly PreparedAttachment[]} attachments
 * @returns {Promise<{ ok: true } | { ok: false, key: string, params?: Record<string, string> }>}
 */
export async function checkSendable(attachments) {
  if (!needsVision(attachments)) return { ok: true };
  if (getChatMode() === 'grounded') return { ok: true };
  const value = getAssistant();
  const candidates = await chatCandidates(value, { vision: true });
  if (candidates.length) return { ok: true };
  if (value === 'auto') return { ok: false, key: 'chat-thread.composer.no_vision_auto' };
  const all = await chatCandidates(value);
  const name = all[0] ? modelLabel(all[0].provider, all[0].model) : t('engine.model_generic');
  return { ok: false, key: 'chat-thread.composer.no_vision', params: { model: name } };
}

/**
 * The thread as export turns (Markdown) and the stored conversation (JSON).
 */
export async function exportData() {
  const thread = await loadSessionThread(conversationId);
  return { thread, path: thread ? activePath(indexNodes(thread.nodes), thread.conversation.activeLeafId) : [] };
}
