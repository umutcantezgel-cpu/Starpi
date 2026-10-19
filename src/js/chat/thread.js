// @ts-check
/**
 * @file The conversation thread: shows the active path of a stored conversation (chat/store.js),
 * sends questions, streams answers through the AI layer (chat/runner.js), and keeps the message
 * tree append-only: editing a question and regenerating an answer add siblings, Continue after the
 * length limit adds a new turn, and the branch navigator switches the active leaf.
 *
 * Two routes per question (ai/hybrid.js decides for Auto, see routeFor):
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
 * - registerTurnNotes(fn): notes for the context block of a free question (packs).
 * - registerRequestNotes(fn): notes for the request of the question being answered only (memory).
 * - registerSystemNote(fn): text appended to the free system prompt (stable per conversation).
 * - setWorkspaceScope(fn): the workspace documents a conversation's grounded questions search.
 * - registerRequestHook(fn): changes a request before it goes out (tools).
 * - setToolRunner(fn): sees every free answer: runs the tool calls it stopped for (approval cards in
 *   its bubble), links its web results.
 * - setAdapterChooser(fn): another adapter for a call of a free answer (provider-side tools).
 * - registerReceiptHook(fn): completes a grounded answer's receipt draft (relations, second opinions).
 * - registerMessageAction(action): an action in every message's bar ("Research this", read aloud).
 * - setAnswerLabeler(fn): the provenance label of an answer.
 * - registerAnswerDecorator(fn): adds to how an answer shows (a note under it).
 *
 * Auto decides with ai/hybrid.js (attachments, references, the workspace probe; a route decider set
 * with setRouteDecider runs first and can only tighten it): free, grounded, or mixed (sources for
 * what they cover, general knowledge marked). Models on this device, the own server and small models
 * get their excerpts as a context pack (ai/context-pack.js), whose short labels are expanded before
 * the source check. Every answer shows its label (answer-labels.js); web answers get the web check.
 *
 * Answers written outside the thread (the side-by-side compare, the council) ask through
 * prepareQuestion() as a free question would go out, are stored with freeAnswerInput() and
 * adoptAnswer() as the newest branch under their question, and are labelled with presentAnswer().
 */
import { chatData, currentSessionId, loadSessionThread, startNewSession } from '../chat-store.js';
import { splitStreamingText } from '../chat-stream.js';
import { APP_VERSION, LIMITS, TIMEOUTS_MS } from '../config.js';
import { contextCoverage, receiptAdvisory } from '../core/grounding.js';
import { startLocalEngine } from '../engine-ui.js';
import { formatNumber, getLocale, hasKey, setText, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';
import { appendLoading, appendMessage, appendNotice, createStreamingMessage, resetMessages } from '../messages.js';
import { modelLabel, providerLabel } from '../providers.js';
import {
  attachmentSection,
  buildInstructions,
  buildSystemPrompt,
  contextSection,
  cutFenced,
  estimateTokens,
  fitPoolRequest,
  freeSystemPrompt,
  POOL_LIMITS,
  historyWindow,
  requestNotesBlock,
  spokenSystemPrompt,
  trimHistory,
  turnContext,
} from '../prompts.js';
import { registerCitations } from '../rag/citations.js';
import { libraryHitsByMeaning } from '../rag/embed-client.js';
import { applyGrounding } from '../rag/grounding-view.js';
import { receiptButton, storeReceiptDraft } from '../rag/receipts.js';
import { checkWebAnswer, readWebCheck } from '../rag/web-check.js';
import { addToWorkspace, firstChunks, getDocumentText, listWorkspace, searchWorkspace, workspaceProbe } from '../rag/workspace.js';
import { assignCitations, buildContext, distinctSources, mergeHits, rankHitsLocally, workspaceHit } from '../retrieval.js';
import { getAssistant, getChatMode, getLlmUrl, getWebSearch, onAssistantChange, setChatMode } from '../state.js';
import { getConnection, listDocuments, recentKnowledge, searchKnowledge } from '../supabase.js';
import { describeChatTrace, describeTrace, isGreeting, synthesizeAnswer } from '../synthesizer.js';
import { setAssistantStatus } from '../ui.js';
import { html, provenanceBadge } from '../ui/kit.js';
import { mountGroundingFrame } from '../render.js';
import { getEngineState, interrupt } from '../webgpu/engine.js';
import { budgetPrompt } from '../webgpu/models.js';
import { applyThinking, thinkingFor } from '../ai/thinking.js';
import { buildContextPack, contextWindowFor, expandLabels, forgetContextWindows, packMessages, shortLabelSources, usesPack, warmUpLocal } from '../ai/context-pack.js';
import { browserWebSearch, decideRoute, ROUTE_TOP_K, searchWebHits } from '../ai/hybrid.js';
import { getKey } from '../ai/keys.js';
import { readAloudStream } from '../features/voice.js';
import { renderActions } from './actions.js';
import { answerLabelOf, applyMixedMarks, nextPaint, renderAnswerLabel, renderWebCheck } from './answer-labels.js';
import { attachmentText, blobToBase64, MAX_NATIVE_PDF_BYTES, needsVision, textBudget } from './attachments.js';
import { clearComposer, setComposerBusy, takeDraft } from './composer.js';
import { showGeneratedImages, storeGeneratedImages } from './image-view.js';
import { answerDecorators, receiptHooks, requestHooks, requestNoteHooks, single, systemNoteHooks, turnNoteHooks } from './hooks.js';
import { capsOf, chatCandidates, compactingAnthropic, runAnswer } from './runner.js';
import { activePath, branchInfo, indexNodes, nodeText, pathTo, switchBranch } from './tree.js';

export {
  registerAnswerDecorator,
  registerMessageAction,
  registerReceiptHook,
  registerRequestHook,
  registerRequestNotes,
  registerSystemNote,
  registerTurnNotes,
  setAnswerLabeler,
  setAdapterChooser,
  setRouteDecider,
  setToolRunner,
  setWorkspaceScope,
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
/** @typedef {import('../core/gate.js').GateSource} GateSource */
/** @typedef {import('../core/gate.js').GateGrounding} GateGrounding */
/** @typedef {import('../voice/hooks.js').LiveTurn} LiveTurn */
/** @typedef {import('../voice/read-aloud.js').ReadableAnswer} ReadableAnswer */
/** @typedef {'free' | 'grounded' | 'web'} ReadLabel */

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
/**
 * The running turn: the conversation its question and answer belong to (taken when the turn starts)
 * and that conversation's thread. The user may open another chat or start a new one while an answer
 * is written; the answer is still stored beside its question, and shows when its chat is shown again
 * (`left`: the screen changed during the turn; `live`: the bubble the answer streams into;
 * `foreign`: the conversation was changed elsewhere during the turn, by the sync or another tab).
 * @type {{ conversationId: string, thread: Thread | null, left: boolean, live: HTMLElement | null, foreign: boolean } | null}
 */
let turn = null;
/** @type {AbortController | null} */
let controller = null;
let showSeq = 0;
/** Base64 and text of stored attachments, by blob id. */
/** @type {Map<string, string>} */
const blobData = new Map();
/**
 * Attachments this browser does not have, and those it said so for: attachments are not synced, so a
 * question restored from the sync names files whose blobs stayed on the device they were added on.
 */
const missingBlobs = new Set();
const missingNoted = new Set();
/** Messages this thread stores itself (their change events are no news to it). */
const ownNodes = new Set();
/** What the screen shows of the conversation on screen (see shownSignature), as last rendered. */
let shown = '';
/** @type {{ at: number, titles: string[] } | null} */
let titlesCache = null;
/**
 * What reading an answer aloud needs beyond its stored text, for the answers of this page: the
 * excerpts a grounded answer was given (they are not stored) and the label of its gate.
 * @type {Map<string, { label: ReadLabel, sources: GateSource[], grounding: GateGrounding | null }>}
 */
const readable = new Map();
/** Answers whose excerpts are kept for reading aloud (the newest ones). */
const READABLE_KEPT = 50;

/**
 * Keeps what reading an answer aloud needs (see `readable`), for the newest answers only.
 * @param {string} id
 * @param {{ label: ReadLabel, sources: GateSource[], grounding: GateGrounding | null }} entry
 */
function keepReadable(id, entry) {
  readable.delete(id);
  readable.set(id, entry);
  for (const old of readable.keys()) {
    if (readable.size <= READABLE_KEPT) break;
    readable.delete(old);
  }
}

/** The conversation the thread shows. */
export function threadConversationId() {
  return conversationId;
}

export function isThreadBusy() {
  return busy;
}

/** The conversation an answer is being written in (null when none is): it may not be the one shown. */
export function answeringConversation() {
  return turn ? turn.conversationId : null;
}

/** @param {string} id */
export function threadNode(id) {
  return current?.tree.byId.get(id) ?? null;
}

export function invalidateKnownTitles() {
  titlesCache = null;
}

// The own server loads a model when the picker selects it, before the first question (Ollama and
// llama.cpp; context-pack.js warmUpLocal), and its context window is read again for the next pack.
onAssistantChange((value) => {
  if (!String(value).startsWith('local:')) return;
  void chatCandidates(value)
    .then(([target]) => {
      if (target?.route !== 'local') return false;
      forgetContextWindows(getLlmUrl(), target.model);
      return warmUpLocal({ baseUrl: getLlmUrl(), model: target.model, key: getKey('local') });
    })
    .catch(() => {});
});

/**
 * An answer as reading it aloud needs it (voice/hooks.js getAnswer): its text, the label that
 * picks the sentence gate, the excerpts a grounded answer was given (known for the answers of this
 * page; an answer restored from history has none, so the gate withholds its numbers) and the web
 * grounding of an answer that searched the web. Null for questions and unknown ids.
 * @param {string} id
 * @returns {ReadableAnswer | null}
 */
export function readableAnswer(id) {
  const node = threadNode(id);
  if (!node || node.role !== 'assistant') return null;
  const meta = metaOf(node);
  const kept = readable.get(id);
  const question = node.parentId ? threadNode(node.parentId) : null;
  const storedGrounding = isGrounding(meta.web_grounding) ? meta.web_grounding : null;
  const route = meta.chat_mode ?? node.label;
  return {
    text: nodeText(node),
    label: kept?.label ?? (route === 'grounded' ? 'grounded' : storedGrounding ? 'web' : 'free'),
    sources: kept?.sources ?? [],
    grounding: kept?.grounding ?? storedGrounding,
    question: question && !metaOf(question).continue ? nodeText(question) : '',
    locale: getLocale(),
  };
}

/**
 * @param {unknown} value
 * @returns {value is GateGrounding}
 */
function isGrounding(value) {
  const g = /** @type {any} */ (value);
  return Boolean(g && Array.isArray(g.segments) && Array.isArray(g.sources));
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

/** The conversation the running turn writes to; between turns the one shown. */
function turnConversation() {
  return turn?.conversationId ?? conversationId;
}

/** The thread of the running turn's conversation; between turns the one shown. */
function turnThread() {
  return turn ? turn.thread : current;
}

/** Whether the running turn's conversation is the one on screen (always true between turns). */
function onScreen() {
  return !turn || turn.conversationId === conversationId;
}

/**
 * A notice of the running turn: shown only while its conversation is on screen.
 * @param {Parameters<typeof appendNotice>[0]} notice
 */
function turnNotice(notice) {
  if (onScreen()) appendNotice(notice);
}

/**
 * A message element the running turn just added: it stays on screen only while the turn's
 * conversation is shown (otherwise it was added to another chat).
 * @template {Element} T
 * @param {T} el
 * @returns {T}
 */
function placed(el) {
  if (!onScreen()) el.remove();
  return el;
}

/** Reads the running turn's conversation again (and the one shown, when it is that one). */
async function reload() {
  const id = turnConversation();
  const loaded = await (await store()).loadThread(id);
  if (turn?.conversationId === id) turn.thread = loaded;
  if (id === conversationId) current = loaded;
}

/**
 * The newest message of the active path.
 * @param {Thread | null} [thread]  default: the running turn's
 */
function leafId(thread = turnThread()) {
  return thread?.path.at(-1)?.id ?? null;
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
 * The provenance label of an answer: a registered labeler's, else its label (answer-labels.js:
 * free, grounded, mixed or web) and, for web answers, the outcome of the web check.
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
  renderAnswerLabel(el, answerLabelOf(node));
  renderWebCheck(el, readWebCheck(metaOf(node).web_check));
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
  void showGeneratedImages(el, node, async (id) => (await store()).getBlob(id));
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
  for (const fn of answerDecorators) {
    try {
      fn(el, node);
    } catch (err) {
      console.warn('[starpi] an answer decorator failed', err);
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
 * Where an answer that searched the web is grounded, for the read-aloud gate: the text ranges its
 * citations cover and the pages they name (null when it cites no page). Bounded, as it is stored
 * with the answer.
 * @param {CompletionResult} result
 * @returns {GateGrounding | null}
 */
export function webGrounding(result) {
  /** @type {GateGrounding['sources']} */
  const sources = [];
  /** @type {GateGrounding['segments']} */
  const segments = [];
  for (const c of result.citations) {
    if (!/^https?:\/\//i.test(c.url)) continue;
    let i = sources.findIndex((s) => s.uri === c.url);
    if (i < 0) {
      if (sources.length >= 32) continue;
      i = sources.push({ uri: c.url.slice(0, 2000), ...(c.title ? { title: String(c.title).slice(0, 200) } : {}) }) - 1;
    }
    if (typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start && segments.length < 200) segments.push({ start: c.start, end: c.end, sources: [i] });
  }
  return sources.length ? { segments, sources } : null;
}

/**
 * A web check a tool runner made itself (the verified web answer of a search pack), in the shape of
 * rag/web-check.js, or null.
 * @param {CompletionResult} result
 * @returns {import('../rag/web-check.js').WebCheck | null}
 */
function runnerWebCheck(result) {
  return readWebCheck(/** @type {{ webCheck?: unknown }} */ (result).webCheck);
}

/**
 * What a free answer stores about the web and its provider state, the same for the thread's answers
 * and those written outside it (compare, council): the pages it cites, where it is grounded (for the
 * read-aloud gate), the outcome of the web check (the tool runner's check of a search pack when it
 * made one, else rag/web-check.js on the citations) and the label that follows from it; no provider
 * state for an answer that stopped with tool calls left open (they must not be replayed).
 * @param {CompletionResult} result
 * @param {{ question: string, locale: string }} asked
 */
function freeAnswerFields(result, asked) {
  const grounding = webGrounding(result);
  // An answer that cites web pages is checked as far as its citations allow (rag/web-check.js).
  const web = runnerWebCheck(result) ?? (result.citations.length ? checkWebAnswer({ text: result.text, provider: result.provider, citations: result.citations, question: asked.question, locale: asked.locale }) : null);
  const checked = web !== null && web.kind !== 'none';
  return {
    label: /** @type {'web' | 'free'} */ (checked ? 'web' : 'free'),
    opaque: result.stopReason === 'tool_call' ? [] : result.opaque,
    grounding,
    meta: {
      ...(result.citations.length ? { web_sources: webSources(result) } : {}),
      ...(grounding ? { web_grounding: grounding } : {}),
      ...(checked ? { web_check: web } : {}),
    },
  };
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
  const canContinue = node.role === 'assistant' && meta.stop_reason === 'max_tokens' && (meta.chat_mode ?? node.label) === 'free' && leafId(current) === node.id;
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
  void followStore();
  const seq = ++showSeq;
  conversationId = id;
  if (turn) turn.left = true;
  /** @type {Thread | null} */
  let loaded = null;
  showing++;
  try {
    loaded = await (await store()).loadThread(id);
  } catch (err) {
    console.warn('[starpi] could not load the conversation', err);
  } finally {
    showing--;
  }
  if (seq !== showSeq) return;
  current = loaded;
  const box = document.getElementById('chatMessages');
  const shownSinceBoot = opts.keepNotices && box ? [...box.children].slice(1).filter((el) => !(el instanceof HTMLElement && el.dataset.nodeId)) : [];
  resetMessages();
  for (const node of current?.path ?? []) renderNode(node);
  shown = shownSignature(current);
  // An answer still being written in this conversation goes on streaming below its question.
  if (turn?.conversationId === id && turn.live) box?.append(turn.live);
  box?.append(...shownSinceBoot);
}

/**
 * Clears the thread on screen (a new chat). An answer still being written goes on in its own
 * conversation and is stored there.
 */
export function resetThread() {
  void followStore();
  conversationId = currentSessionId();
  if (turn) turn.left = true;
  current = null;
  shown = '';
  ++showSeq;
  resetMessages();
  setAssistantStatus(busy ? 'status.generating' : 'status.ready');
}

// ---------------------------------------------------------------------------------------------
// Following changes made elsewhere (the sync, other tabs)
// ---------------------------------------------------------------------------------------------

/** Pause after a change event before the chat on screen is read again (changes come in bursts). */
const FOLLOW_MS = 150;
/** Pause before trying again while a question is being edited in place. */
const FOLLOW_EDIT_MS = 1_500;
/** @type {Promise<void> | null} */
let followed = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let followTimer = null;
/** showConversation calls still reading the store (a follow waits for them rather than overtake them). */
let showing = 0;

/**
 * What the screen shows of a conversation, to tell whether a change elsewhere touched it: the active
 * path, each message's branches and what it carries.
 * @param {Thread | null} thread
 */
function shownSignature(thread) {
  if (!thread) return '';
  return JSON.stringify(thread.path.map((n) => [n.id, branchInfo(thread.tree, n.id)?.count ?? 1, n.label ?? null, n.receiptId ?? null, n.parts.length, nodeText(n).length, JSON.stringify(n.meta ?? null).length]));
}

/**
 * Notes a message this thread stores itself, so its change event is not taken for a change elsewhere.
 * @param {string} id
 */
function ownNode(id) {
  ownNodes.add(id);
  if (ownNodes.size > 500) ownNodes.delete(/** @type {string} */ (ownNodes.values().next().value));
}

/** Starts following the store's change events (once). */
function followStore() {
  followed ??= store()
    .then((db) => {
      db.onChange(noteStoreChange);
    })
    .catch((err) => {
      followed = null;
      console.warn('[starpi] the chat cannot follow changes made elsewhere', err);
    });
  return followed;
}

/**
 * A change of the store (made here, in another tab, or by the sync merging another browser's
 * changes): the chat on screen is read again when it concerns it. While an answer is written in it,
 * a change from elsewhere waits for the end of the turn.
 * @param {import('./store.js').ChatChange} change
 */
function noteStoreChange(change) {
  const id = conversationId;
  const concerns = change.kind === 'all' || (change.kind === 'conversation' && change.id === id) || (change.kind === 'node' && change.conversationId === id);
  // A message stored here is on screen already (or shows with the end of its turn).
  if (!concerns || (change.kind === 'node' && ownNodes.has(change.id))) return;
  if (turn && turn.conversationId === id) {
    if (change.kind === 'all' || change.kind === 'node' || (change.kind === 'conversation' && change.op === 'delete')) turn.foreign = true;
    return;
  }
  scheduleFollow(FOLLOW_MS);
}

/** @param {number} ms */
function scheduleFollow(ms) {
  if (followTimer !== null) clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    followTimer = null;
    void followShown().catch((err) => console.warn('[starpi] the chat could not follow a change', err));
  }, ms);
}

/**
 * Brings the chat on screen in line with the store: a conversation deleted elsewhere (another tab, or
 * another browser through the sync) returns to a new chat; one changed elsewhere shows what is stored
 * now. Nothing happens for a chat whose session moved on (deleted here, a new chat) or that is not
 * stored yet, and a question being edited in place is not taken away.
 */
async function followShown() {
  const id = conversationId;
  if (!current || current.conversation.id !== id || currentSessionId() !== id) return;
  if (turn?.conversationId === id) return;
  // A conversation being shown right now: its showing may read the store before the change, so the
  // follow comes again after it.
  if (showing > 0) return scheduleFollow(FOLLOW_MS);
  const loaded = await (await store()).loadThread(id).catch(() => undefined);
  if (loaded === undefined || conversationId !== id || currentSessionId() !== id || turn?.conversationId === id) return;
  if (showing > 0) return scheduleFollow(FOLLOW_MS);
  if (!loaded) {
    startNewSession();
    resetThread();
    appendNotice({ icon: 'trash-2', tone: 'info', title: 'chat-thread.notice.deleted_elsewhere_title', body: 'chat-thread.notice.deleted_elsewhere_body' });
    return;
  }
  if (shownSignature(loaded) === shown) {
    current = loaded;
    return;
  }
  if (document.querySelector('#chatMessages .message-editor')) {
    scheduleFollow(FOLLOW_EDIT_MS);
    return;
  }
  await showConversation(id);
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * A stored blob as base64 (cached for the page); null when this browser does not have it.
 * @param {string} blobId
 * @returns {Promise<string | null>}
 */
async function blobBase64(blobId) {
  const key = `b64:${blobId}`;
  const cached = blobData.get(key);
  if (cached !== undefined) return cached;
  if (missingBlobs.has(blobId)) return null;
  const record = await (await store()).getBlob(blobId);
  if (!record) {
    missingBlobs.add(blobId);
    return null;
  }
  const data = await blobToBase64(record.data);
  blobData.set(key, data);
  return data;
}

/**
 * The text of a stored file attachment (plain text read, documents and PDFs extracted), cached;
 * null when this browser does not have the file.
 * @param {StoredPart} part
 * @returns {Promise<string | null>}
 */
async function blobText(part) {
  const blobId = String(part.blobId ?? '');
  const key = `txt:${blobId}`;
  const cached = blobData.get(key);
  if (cached !== undefined) return cached;
  if (missingBlobs.has(blobId)) return null;
  const record = await (await store()).getBlob(blobId);
  if (!record) {
    missingBlobs.add(blobId);
    return null;
  }
  let text = '';
  try {
    text =
      part.kind === 'text'
        ? await record.data.text()
        : await attachmentText({ id: blobId, name: String(part.name ?? 'file'), kind: part.kind === 'pdf' ? 'pdf' : 'document', mime: record.type, blob: record.data, file: /** @type {File} */ (record.data) });
  } catch (err) {
    console.warn('[starpi] an attached file could not be read', err);
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
 * A stored question as a message for one model: its context block (free questions), the notes for
 * this request only (the question being answered), its attachments as the model can take them, and
 * its text. An attachment this browser does not have (restored from the sync, which carries no
 * attachments) goes as its name only and is added to `missing`.
 * @param {NodeRecord} node
 * @param {Target} target
 * @param {Caps} caps
 * @param {readonly string[]} [requestNotes]
 * @param {Map<string, string>} [missing]  blob id -> name of the attachments left out
 * @returns {Promise<Message>}
 */
async function userMessage(node, target, caps, requestNotes = [], missing = new Map()) {
  const meta = metaOf(node);
  const locale = getLocale();
  /** @type {Part[]} */
  const content = [];
  if (typeof meta.context === 'string' && meta.context) content.push({ type: 'text', text: meta.context });
  const notesBlock = requestNotesBlock(locale, requestNotes);
  if (notesBlock) content.push({ type: 'text', text: notesBlock });
  let room = textBudget(caps);
  /** @param {string} blobId @param {string} name */
  const leftOut = (blobId, name) => {
    missing.set(blobId, name);
    content.push({ type: 'text', text: `[${name}]` });
  };
  for (const p of node.parts) {
    if (p.type === 'image' && typeof p.blobId === 'string') {
      const name = String(p.name ?? 'image');
      const data = caps.vision ? await blobBase64(p.blobId) : null;
      if (data) content.push({ type: 'image', mime: /** @type {import('../ai/contract.js').ImageMime} */ (p.mime ?? 'image/jpeg'), data, name: String(p.name ?? '') });
      else if (caps.vision) leftOut(p.blobId, name);
      else content.push({ type: 'text', text: `[${name}]` });
    } else if (p.type === 'file' && typeof p.blobId === 'string') {
      const name = String(p.name ?? (p.kind === 'pdf' ? 'document' : 'file'));
      const size = typeof p.size === 'number' ? p.size : 0;
      if (p.kind === 'pdf' && caps.pdf && target.route !== 'pool' && size <= MAX_NATIVE_PDF_BYTES) {
        const data = await blobBase64(p.blobId);
        if (data) content.push({ type: 'file', mime: 'application/pdf', data, name });
        else leftOut(p.blobId, name);
      } else {
        const raw = await blobText(p);
        if (raw === null) {
          leftOut(p.blobId, name);
          continue;
        }
        const text = fitText(raw, room);
        room -= text.length;
        content.push({ type: 'text', text: attachmentSection(locale, { name, text }) });
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
 * Says once per attachment that it was left out of a request: attachments are not synced, so this
 * browser does not have the files of a question restored from the sync.
 * @param {Map<string, string>} missing  blob id -> name
 */
function noteMissing(missing) {
  /** @type {string[]} */
  const names = [];
  for (const [blobId, name] of missing) {
    if (missingNoted.has(blobId)) continue;
    missingNoted.add(blobId);
    names.push(name);
  }
  if (names.length) turnNotice({ icon: 'paperclip', tone: 'info', title: 'chat-thread.notice.attachment_missing_title', body: 'chat-thread.notice.attachment_missing_body', params: { names: names.join(', '), n: names.length } });
}

/**
 * Whether a model runs on this device or on the user's own server (turns that stay on this device
 * may go to it).
 * @param {Target} target
 */
function onThisDevice(target) {
  return target.route === 'device' || target.route === 'local';
}

/**
 * The turns of a path a model may get: questions answered on this device stay on it for every
 * model that is not on this device too.
 * @param {NodeRecord[]} path
 * @param {Target} target
 */
function shareable(path, target) {
  if (onThisDevice(target)) return path;
  return path.filter((node, i) => !node.localOnly && !(node.role === 'user' && path[i + 1]?.localOnly));
}

/** The notice for a question that stays on this device when another model was asked to answer it. */
const STAYS_ON_DEVICE = Object.freeze({ icon: 'lock', tone: /** @type {const} */ ('info'), title: 'chat-thread.notice.stays_on_device_title', body: 'chat-thread.notice.stays_on_device_body' });

/**
 * Whether a question was asked to stay on this device (a free one asked there, or a grounded one
 * asked with the model of this device): then only the model here or the own server answers it
 * (again), never a provider or the site's pools.
 * @param {NodeRecord} question
 */
function staysOnDevice(question) {
  const meta = metaOf(question);
  return question.role === 'user' && question.localOnly && (meta.chat_mode !== 'grounded' || meta.device_only === true);
}

/**
 * Whether the conversation holds a compaction block of the server (it then must keep compacting).
 * @param {NodeRecord[]} path
 */
function hasCompaction(path) {
  return path.some((n) => (n.opaque ?? []).some((o) => JSON.stringify(/** @type {any} */ (o)?.block ?? null).includes('"type":"compaction"')));
}

/**
 * The output limit of a free answer for a model: at most half its context, so the conversation
 * keeps room (a small context, as assumed for an own server that does not tell its size, would
 * otherwise leave none for the earlier turns).
 * @param {Target} target
 * @param {Caps} caps
 */
function answerTokens(target, caps) {
  if (target.route === 'device') return undefined;
  const half = caps.contextTokens ? Math.max(256, Math.floor(caps.contextTokens / 2)) : Infinity;
  const cap = target.route === 'pool' ? 4096 : target.route === 'local' ? SERVER_ANSWER_TOKENS : CLOUD_ANSWER_TOKENS;
  return Math.min(caps.maxOutput || cap, cap, half);
}

/**
 * Whether a free question to this model searches the web (the Web toggle, a model that can, and
 * not on the site's pools).
 * @param {Target} target
 */
function searchesWeb(target) {
  return getWebSearch() && capsOf(target.provider, target.model).search !== 'none' && target.route !== 'pool';
}

/**
 * The free request for one model: the stable system prompt, the history (whole for Anthropic,
 * within the model's context for the others, within the pool's limits on the site's pools) and the
 * question with the notes for this request.
 * @param {Target} target
 * @param {NodeRecord[]} path  the active path ending with the question
 * @param {TurnContext} ctx
 * @param {readonly string[]} [requestNotes]  registerRequestNotes, for the question only
 * @returns {Promise<AiRequest>}
 */
async function freeRequest(target, path, ctx, requestNotes = []) {
  const caps = capsOf(target.provider, target.model);
  const locale = getLocale();
  const who = target.route === 'device' ? 'local' : target.route === 'local' ? 'server' : 'cloud';
  const notes = (await Promise.all([...systemNoteHooks].map((fn) => Promise.resolve(fn(ctx)).catch((err) => (console.warn('[starpi] a system note hook failed', err), ''))))).filter(Boolean);
  const system = [freeSystemPrompt(who, locale), ...notes].join('\n\n');
  const asked = /** @type {NodeRecord} */ (path.at(-1));
  // Never reached: answerFree offers such a question to the model here and the own server only.
  if (staysOnDevice(asked) && !onThisDevice(target)) throw Object.assign(new Error('The question stays on this device'), { code: 'stays_on_device' });
  /** @type {Message[]} */
  let history = [];
  /** @type {Map<string, string>} */
  const missing = new Map();
  for (const node of shareable(path.slice(0, -1), target)) {
    if (node.role === 'user') history.push(await userMessage(node, target, caps, [], missing));
    else if (node.role === 'assistant') history.push(assistantMessage(node));
  }
  // The question itself always goes along (the history above only leaves out what stays here).
  const question = await userMessage(asked, target, caps, requestNotes, missing);
  noteMissing(missing);
  const maxOutputTokens = answerTokens(target, caps);
  if (target.provider !== 'anthropic') {
    const budget = caps.contextTokens - (maxOutputTokens ?? Math.floor(caps.contextTokens / 2)) - estimateTokens(system) - estimateTokens(question) - 256;
    history = trimHistory(history, Math.max(0, budget));
  }
  /** @type {AiRequest} */
  let req = { provider: target.provider, model: target.model, system, messages: [...history, question], temperature: 0.7, ...(maxOutputTokens ? { maxOutputTokens } : {}) };
  if (searchesWeb(target)) req.search = { enabled: true };
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
 * The part of a streaming answer that may be read aloud: its visible text (reasoning a model wrote
 * into its text stays out, and an opening tag still arriving is held until it shows whether it
 * starts reasoning), as long as it extends what was read already; otherwise what was read.
 * @param {string} text  the streamed text so far
 * @param {string} read  the part handed to the reader so far
 */
export function readableSoFar(text, read) {
  const view = splitStreamingText(text);
  const visible = view.thinking || /^\s*<[a-z]*$/i.test(view.answer) ? '' : view.answer;
  return visible.length > read.length && visible.startsWith(read) ? visible : read;
}

/**
 * Streams one answer into a new bubble. With "read answers aloud" switched on (voice settings), the
 * answer is read while it streams, through the gate its `read` description names (decided once the
 * answering model is known); a stopped or failed answer ends the reading.
 * @param {Target[]} candidates
 * @param {(target: Target) => Promise<AiRequest>} build
 * @param {AbortSignal} signal
 * @param {{ before?: Element | null }} [placement]
 * @param {(target: Target) => Omit<ReadableAnswer, 'text'>} [read]
 */
async function streamAnswer(candidates, build, signal, placement = {}, read) {
  const stream = createStreamingMessage('', undefined, placement);
  placed(stream.element);
  if (turn) turn.live = stream.element;
  let text = '';
  let reasoning = '';
  /** @type {import('../voice/hooks.js').AnswerReader | null | undefined} undefined: not decided yet */
  let reader;
  /** The part of the answer handed to the reader: never reasoning a model wrote into its text. */
  let readText = '';
  /** @type {import('./runner.js').RunResult} */
  let run;
  try {
    run = await runAnswer({
      candidates,
      signal,
      build,
      onStart: (target, served) => {
        stream.setBadge(...badgeArgs(target, served));
        const badge = document.getElementById('servedModel');
        if (badge && onScreen()) {
          setText(badge, 'chat-thread.picker.served', { model: `${providerLabel(target.provider)} · ${modelLabel(target.provider, served || target.model)}` });
          badge.classList.remove('hidden');
        }
      },
      onEvent: (ev, target) => {
        if (ev.type === 'text') {
          text += ev.delta;
          stream.update(text);
          if (reader === undefined) reader = read ? readAloudStream(read(target)) : null;
          const next = reader ? readableSoFar(text, readText) : readText;
          if (reader && next.length > readText.length) {
            reader.push(next.slice(readText.length));
            readText = next;
          }
        } else if (ev.type === 'reasoning' && typeof ev.delta === 'string') {
          reasoning += ev.delta;
          stream.reasoning(reasoning);
        }
      },
      adapterFor: (target, req) => single.adapter?.(target, req) ?? (target.provider === 'anthropic' && (estimateTokens(JSON.stringify(req.messages)) > COMPACTION_TOKENS || hasCompaction(turnThread()?.path ?? [])) ? compactingAnthropic() : undefined),
    });
  } catch (err) {
    // A request that could not be built or sent leaves no bubble behind.
    reader?.abort();
    stream.remove();
    throw err;
  } finally {
    if (turn?.live === stream.element) turn.live = null;
  }
  if (reader) {
    if (signal.aborted || !run.target || !run.result.text.trim()) reader.abort();
    else reader.end({ grounding: webGrounding(run.result) });
  }
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
  const id = turnConversation();
  const existing = await db.getConversation(id);
  if (existing) {
    void db.updateConversation(id, { mode: getChatMode(), model: getAssistant() }).catch(() => {});
    return existing;
  }
  // The chat was stored when the turn started and is gone now: it was deleted meanwhile, and stays so.
  if (turn?.thread) throw new DOMException('The chat was deleted', 'AbortError');
  return db.createConversation({ id, mode: route === 'grounded' && getChatMode() === 'grounded' ? 'grounded' : getChatMode(), model: getAssistant() });
}

/**
 * Stores a question with its attachments (as blobs owned by it).
 * @param {{ text: string, attachments: PreparedAttachment[], parentId: string | null, route: 'free' | 'grounded', localOnly: boolean, deviceOnly?: boolean, context?: string, continueOf?: boolean, reuseParts?: StoredPart[] }} q
 *   deviceOnly: a grounded question asked with the model of this device (it stays here, see staysOnDevice)
 * @returns {Promise<NodeRecord>}
 */
async function storeQuestion(q) {
  const db = await store();
  await ensureConversation(db, q.route);
  const id = crypto.randomUUID();
  ownNode(id);
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
  if (q.deviceOnly) meta.device_only = true;
  const node = await db.appendNode(turnConversation(), { id, parentId: q.parentId, role: 'user', parts, localOnly: q.localOnly, meta });
  await reload();
  return node;
}

/**
 * The providers that may name a conversation after its first answer: the one that answered (on the
 * route it answered on, as a provider has one route at a time), so the question and the answer
 * reach no one the answer did not already go to; none for an answer that stays on this device
 * (then only the model here names it).
 * @param {Pick<NodeRecord, 'provider' | 'localOnly'>} answer
 * @returns {import('../ai/contract.js').ProviderId[]}
 */
export function titleProviders(answer) {
  if (answer.localOnly || !answer.provider || answer.provider === 'webgpu' || answer.provider === 'wasm') return [];
  return [/** @type {import('../ai/contract.js').ProviderId} */ (answer.provider)];
}

/**
 * Asks for a short title after the first answer of a conversation that still has the automatic
 * one; the first words of the question stay when no model names it.
 * @param {string} id  the conversation
 * @param {string} question
 * @param {NodeRecord} answer
 */
async function nameConversation(id, question, answer) {
  const db = await store();
  const conversation = await db.getConversation(id);
  const { titleFromText } = await import('./store.js');
  if (!conversation || conversation.title !== titleFromText(question)) return;
  try {
    const { runPurpose } = await import('../ai/router.js');
    const input = { messages: [{ role: 'user', text: question }, { role: 'assistant', text: nodeText(answer).slice(0, 1500) }] };
    const r = await runPurpose('title_chat', input, { cache: 'off', signal: AbortSignal.timeout(TIMEOUTS_MS.chatTitle), providers: titleProviders(answer) });
    if (!r.ok || r.tier === 'template' || !r.text) return;
    const now = await db.getConversation(id);
    if (now && now.title === conversation.title) await db.updateConversation(id, { title: r.text });
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
  // A question that stays on this device is answered here or by the own server, by no one else.
  if (staysOnDevice(question)) {
    const here = candidates.filter(onThisDevice);
    if (candidates.length && !here.length) {
      turnNotice(STAYS_ON_DEVICE);
      return null;
    }
    candidates = here;
  }
  if (!candidates.length) {
    turnNotice({ icon: 'info', tone: 'info', title: 'chat.free_no_model_title', body: hasImages ? 'chat-thread.notice.no_vision_model' : 'chat-thread.notice.no_model_body' });
    return null;
  }
  const path = turnThread()?.path ?? [question];
  /** @type {TurnContext} */
  const ctx = { conversationId: turnConversation(), question: nodeText(question), mode: getChatMode(), route: 'free', target: candidates[0], locale: getLocale(), attachments: chipsOf(question) };
  const notes = await requestNotesFor(question, ctx);
  const { stream, run } = await streamAnswer(candidates, (target) => freeRequest(target, path, ctx, notes), signal, placement, (target) => ({ label: searchesWeb(target) ? 'web' : 'free', question: ctx.question, locale: ctx.locale }));
  let { result } = run;
  // The registered runner sees the answer: tool calls it stopped for run there (approval cards in the
  // bubble), and it returns the answer after them.
  if (single.tools && run.target && !signal.aborted) {
    const asked = run.target;
    const after = await single.tools({ result, request: () => freeRequest(asked, path, ctx, notes), ctx, signal, view: { element: stream.element, update: (next) => stream.update(next) } }).catch(() => null);
    if (after) result = after;
  }
  const text = result.text;
  const durationMs = Math.round(performance.now() - started);
  if ((!text.trim() && !result.images.length) || !run.target) {
    stream.remove();
    if (!signal.aborted && onScreen()) noticeFor(result, true);
    return null;
  }
  const target = run.target;
  const note = attemptNote(run.attempts, result);
  const badge = answerBadge({ provider: target.provider, model: result.model, meta: { requested: target.model, route: target.route } });
  const trace = describeChatTrace({ engineLabel: t(badge.badge, badge.badgeParams), durationMs, attachment: chipsOf(question).map((c) => c.name).join(', ') || null, note });
  const fields = freeAnswerFields(result, ctx);
  const grounding = fields.grounding;
  const db = await store();
  // Generated images become blobs owned by the answer (image-view.js).
  const answerId = crypto.randomUUID();
  ownNode(answerId);
  const images = result.images.length ? await storeGeneratedImages(result.images, (blob, o) => db.putBlob(blob, o), answerId) : [];
  const node = await db.appendNode(turnConversation(), {
    id: answerId,
    parentId: question.id,
    role: 'assistant',
    parts: [{ type: 'text', text }, ...images],
    // Tool calls without results must not be replayed later: such an answer keeps no provider state.
    opaque: fields.opaque,
    model: result.model,
    provider: result.provider,
    label: fields.label,
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
      ...fields.meta,
      ...(run.attempts.length > 1 ? { attempts: run.attempts.map((a) => ({ provider: a.provider, model: a.model, outcome: a.outcome, ...(a.code ? { code: a.code } : {}) })) } : {}),
    },
  });
  await reload();
  keepReadable(node.id, { label: grounding ? 'web' : 'free', sources: [], grounding });
  stream.element.dataset.nodeId = node.id;
  stream.finalize(text, { citations: null, trace, durationMs, traceRoles: FREE_TRACE_ROLES, reasoning: result.reasoning, meta: metaLine(node) });
  labelAnswer(stream.element, node);
  decorateAnswer(stream.element, node);
  if (result.error && !signal.aborted && onScreen()) noticeFor(result, true);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Grounded answers
// ---------------------------------------------------------------------------------------------

/**
 * The titles of the library's documents: none while it is known to be unreachable (offline), null
 * when listing them failed otherwise (unknown, not empty: never cached).
 * @returns {Promise<string[] | null>}
 */
async function libraryTitles() {
  if (titlesCache && Date.now() - titlesCache.at < 60_000) return titlesCache.titles;
  if (getConnection().status === 'offline') return [];
  const res = await listDocuments();
  if (!res.ok) return null;
  const titles = res.data.map((d) => d.title);
  titlesCache = { at: Date.now(), titles };
  return titles;
}

async function knownTitles() {
  return (await libraryTitles()) ?? [];
}

/**
 * Workspace chunks for the question; just-attached files always contribute (their best chunks, or
 * their first chunks when nothing in them matches, e.g. "summarize this file") and come first.
 * @param {string} query
 * @param {string[]} focus  ids of the files attached to this question
 * @param {readonly string[] | null} [docIds]  search only these documents (and the attached files)
 * @returns {Promise<{ hits: KnowledgeHit[], pinned: number }>}
 */
async function retrieveWorkspace(query, focus, docIds = null) {
  try {
    const found = await scopedWorkspaceSearch(query, focus, docIds);
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
 * The workspace search of the running turn: within the documents its conversation is scoped to
 * (setWorkspaceScope, e.g. a project's files) and the files attached to the question, when a scope
 * is set. Documents the question names itself (`docIds`: an entity found in some files) replace the
 * conversation's scope.
 * @param {string} query
 * @param {string[]} focus
 * @param {readonly string[] | null} [docIds]
 */
async function scopedWorkspaceSearch(query, focus, docIds = null) {
  const scope = docIds?.length ? docIds : single.scope ? await Promise.resolve(single.scope(turnConversation())).catch(() => null) : null;
  if (!scope?.length) return searchWorkspace(query, LIMITS.retrievalRows);
  return searchWorkspace(query, LIMITS.retrievalRows, { docIds: [...new Set([...scope, ...focus])] });
}

/**
 * The excerpts for a grounded question: the workspace, and the knowledge base (searched with the
 * question, or for a question that stays on this device ranked here without sending it).
 * @param {string} query
 * @param {string[]} focus
 * @param {{ workspaceOnly: boolean, deviceOnly: boolean, docIds?: readonly string[] | null }} opts
 *   docIds: the workspace documents to search (else the conversation's scope)
 * @returns {Promise<{ hits: KnowledgeHit[], method: string, kbUnavailable: boolean }>}
 */
async function retrieve(query, focus, opts) {
  const { hits: local, pinned } = await retrieveWorkspace(query, focus, opts.docIds ?? null);
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
 * The i18n key of a workspace error: the workspace's own text for every code it names, else the
 * general one.
 * @param {unknown} err
 */
export function workspaceErrorKey(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  return /^[a-z_]+$/.test(code) && code !== 'title' && hasKey(`workspace.error_${code}`) ? `workspace.error_${code}` : 'workspace.error_internal';
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
          turnNotice({ icon: 'info', tone: 'info', title: 'chat-thread.notice.image_not_source', params: { name: att.name } });
          continue;
        }
        ocr = ocrHook();
      }
      const doc = await addToWorkspace(att.file, ocr ? { ocr } : {});
      ids.push(doc.docId);
    } catch (err) {
      turnNotice({ icon: 'triangle-alert', tone: 'warn', title: 'workspace.error_title', body: workspaceErrorKey(err), params: { name: att.name } });
    }
  }
  return ids;
}

/**
 * The workspace documents of the files an edited grounded question keeps: each stored file is added
 * again (the workspace knows a file it holds already and returns it), an image is found by its name
 * when its recognised text is still there (recognising it again would need the user's consent).
 * @param {StoredPart[]} parts
 * @returns {Promise<string[]>}
 */
async function keptSources(parts) {
  /** @type {string[]} */
  const ids = [];
  const db = await store();
  for (const p of parts) {
    const name = String(p.name ?? 'file');
    if (p.type === 'image') {
      const doc = listWorkspace().find((d) => d.name === name);
      if (doc) ids.push(doc.docId);
      continue;
    }
    if (p.type !== 'file' || typeof p.blobId !== 'string') continue;
    try {
      const record = await db.getBlob(p.blobId);
      if (!record) continue;
      const doc = await addToWorkspace(new File([record.data], name, { type: record.type }));
      ids.push(doc.docId);
    } catch (err) {
      turnNotice({ icon: 'triangle-alert', tone: 'warn', title: 'workspace.error_title', body: workspaceErrorKey(err), params: { name } });
    }
  }
  return ids;
}

/**
 * What a grounded request delivered: the context that went out (the source check compares with
 * it) and, for a context pack, the pack (its labels are expanded and its coverage is the check's).
 * @typedef {{ context: string, pack?: import('../ai/context-pack.js').ContextPack | null }} Delivered
 */

/**
 * The grounded request for one model. Models on this device, the own server and small models get a
 * context pack (and every mixed answer does); otherwise on this device the instructions, excerpts,
 * history and question are budgeted into the loaded model's context, and on the site's pools they
 * are fitted to the pool's limits. `delivered` receives what actually went out.
 * @param {Target} target
 * @param {{ question: string, context: string, citations: import('../retrieval.js').Citation[], mode: 'grounded' | 'mixed', history: NodeRecord[], delivered: Delivered }} input
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
  input.delivered.pack = null;
  if (input.mode === 'mixed' || usesPack(target, caps)) return packedRequest(target, caps, turns, input);
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
 * A grounded or mixed request built from a context pack, sized for the model's context window (the
 * own server's as it reports it): the instruction as the system prompt, the earlier turns, then the
 * context block with the question.
 * @param {Target} target
 * @param {Caps} caps
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} turns
 * @param {{ question: string, citations: import('../retrieval.js').Citation[], mode: 'grounded' | 'mixed', delivered: Delivered }} input
 * @returns {Promise<AiRequest>}
 */
async function packedRequest(target, caps, turns, input) {
  const engine = target.route === 'device' ? getEngineState().model : null;
  const contextTokens = await contextWindowFor(target, caps, { deviceWindow: engine?.chatOptions.context_window_size ?? null, baseUrl: getLlmUrl(), key: getKey('local') });
  const maxOutputTokens = target.route === 'device' ? (engine ? await (await import('../models/bench-rates.js')).localAnswerTokens(engine, { free: false }) : 512) : answerTokens(target, { ...caps, contextTokens });
  const who = target.route === 'device' ? 'local' : target.route === 'local' ? 'server' : 'cloud';
  const pack = buildContextPack({
    question: input.question,
    passages: input.citations,
    model: { contextTokens, maxOutputTokens, who },
    locale: getLocale(),
    mode: input.mode,
    ...(target.route === 'pool' ? { maxChars: POOL_LIMITS.maxMessageChars - input.question.length - 400 } : {}),
  });
  input.delivered.context = pack.contextText;
  input.delivered.pack = pack;
  /** @type {AiRequest} */
  let req = { provider: target.provider, model: target.model, system: pack.system, messages: packMessages(pack, turns, { contextTokens, maxOutputTokens }), temperature: 0.2, maxOutputTokens };
  if (target.route !== 'device') req = applyThinking(req, thinkingFor({ provider: target.provider, model: target.model, caps, show: true }));
  if (target.route === 'pool') {
    const fitted = fitPoolRequest({ system: req.system, messages: req.messages });
    req = { ...req, system: fitted.system, messages: fitted.messages };
  }
  return req;
}

/**
 * What reached the model of every excerpt: the pack's coverage, else the fenced context parsed back.
 * @param {import('../retrieval.js').Citation[]} citations
 * @param {Delivered} delivered
 */
function coverageOf(citations, delivered) {
  return delivered.pack ? delivered.pack.coverage : contextCoverage(citations, delivered.context);
}

/**
 * The excerpts of a grounded answer as the sentence gate takes them: each with the text that
 * reached the model (`coverage`, index-aligned).
 * @param {Array<{ label: string, text: string }>} citations
 * @param {Array<{ text: string }>} coverage
 * @returns {GateSource[]}
 */
function gateSources(citations, coverage) {
  return citations.map((c, i) => ({ index: i, label: c.label, text: coverage[i]?.text ?? c.text, kind: 'doc' }));
}

/**
 * The gate's counts for a receipt: how many units of the answer the sentence gate released in
 * sources mode and how many it withheld.
 * @param {string} answer
 * @param {GateSource[]} sources
 */
async function gateCounts(answer, sources) {
  try {
    const { checkText } = await import('../core/gate.js');
    const r = checkText(answer, { mode: 'sources', sources });
    return { mode: /** @type {const} */ ('sources'), released: r.released.length, withheld: r.withheld?.length ?? 0 };
  } catch (err) {
    console.warn('[starpi] the sentence gate could not judge the answer', err);
    return null;
  }
}

/**
 * Answers a grounded question: retrieval, an answer from the model (or quoted from the sources),
 * the source check and a receipt draft, for every model. A mixed question (Auto, a weaker match in
 * the workspace) takes fewer excerpts, may add general knowledge, and gets its checked parts marked;
 * with `web`, pages of a web search join the excerpts.
 * @param {{ text: string, attachments: PreparedAttachment[], reuseParts?: StoredPart[], parentId: string | null, value: AssistantValue, workspaceOnly: boolean, question?: NodeRecord, mode?: 'grounded' | 'mixed', web?: boolean, reasons?: string[], held?: boolean, docIds?: readonly string[] }} q
 *   reuseParts: the stored files an edited question keeps (they are searched first, as attached files are);
 *   held: the question stays on this device (an edited one that replaces such a question);
 *   docIds: the workspace documents to search (an entity found only in some files)
 * @param {AbortSignal} signal
 * @param {{ before?: Element | null }} [placement]
 */
async function answerGrounded(q, signal, placement = {}) {
  const started = performance.now();
  const kept = (q.reuseParts ?? []).filter((p) => p.type === 'image' || p.type === 'file');
  const chips = [...q.attachments.map((a) => ({ name: a.name, kind: /** @type {'image' | 'file'} */ (a.kind === 'image' ? 'image' : 'file') })), ...kept.map((p) => ({ name: String(p.name ?? ''), kind: /** @type {'image' | 'file'} */ (p.type === 'image' ? 'image' : 'file') }))];
  // The question shows at once; it is stored once retrieval shows whether it stays on this device.
  const pending = q.question ? null : appendMessage('user', q.text, { attachments: chips });
  const removeLoading = appendLoading('chat.thinking');
  try {
    const focus = [...new Set([...(await addToSources(q.attachments)), ...(await keptSources(kept))])];
    // A question asked with the model of this device stays here, also when it is answered again.
    const held = q.held ?? (q.question ? staysOnDevice(q.question) : false);
    const deviceOnly = q.value === 'device' || held;
    const mixed = q.mode === 'mixed';
    const { hits, method, kbUnavailable } = await retrieve(q.text, focus, { workspaceOnly: q.workspaceOnly, deviceOnly, docIds: q.docIds ?? null });
    const webFound = q.web && !deviceOnly ? await searchWebHits(q.text, { search: await browserWebSearch(getLocale()), signal }) : [];
    const greeting = !chips.length && isGreeting(q.text);
    const used = greeting ? [] : [...(mixed ? hits.slice(0, ROUTE_TOP_K.mixed) : hits), ...webFound];
    const usesWorkspace = used.some((h) => h.workspace);
    // The question follows its answer's storage rule: about the workspace (or on this device), it stays here.
    const question = q.question ?? (await storeQuestion({ text: q.text, attachments: q.attachments, reuseParts: kept, parentId: q.parentId, route: 'grounded', localOnly: deviceOnly || usesWorkspace, deviceOnly }));
    if (pending) {
      pending.dataset.nodeId = question.id;
      renderActions(pending, barState(question));
    }
    const history = (turnThread()?.path ?? []).slice(0, -1);
    const citationList = assignCitations(used, { excerptChars: LIMITS.excerptChars });
    const scope = registerCitations(citationList);
    const sources = distinctSources(used);
    const context = buildContext(citationList, { maxChars: LIMITS.contextCharsCloud });
    /** @type {Delivered} */
    const delivered = { context, pack: null };

    let candidates = await chatCandidates(q.value);
    // The model of this device is offered (with its download question) before the sources are quoted.
    if (!candidates.length && q.value === 'device' && !signal.aborted && (await startLocalEngine({ interactive: true }))) candidates = await chatCandidates(q.value);
    if (held) {
      const here = candidates.filter(onThisDevice);
      if (candidates.length && !here.length) turnNotice(STAYS_ON_DEVICE);
      candidates = here;
    }
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
      const view = await streamAnswer(candidates, (target) => groundedRequest(target, { question: q.text, context, citations: citationList, mode: mixed ? 'mixed' : 'grounded', history, delivered }), signal, placement, () => ({
        label: 'grounded',
        // A pack answer streams with the pack's short labels.
        sources: shortLabelSources(gateSources(citationList, coverageOf(citationList, delivered)), delivered.pack?.map),
        question: q.text,
        locale: getLocale(),
      }));
      run = view.run;
      // A pack answer cites [S1] …: the canonical labels go into the answer before anything checks it.
      text = run.result.text.trim() ? (delivered.pack ? expandLabels(run.result.text, delivered.pack.map) : run.result.text) : '';
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
    if (failure) turnNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.provider_failed_title', body: 'chat.provider_failed_body', params: { reason: failure } });
    const durationMs = Math.round(performance.now() - started);
    if (!text) {
      text = synthesizeAnswer({
        query: q.text,
        hits: used,
        citations: citationList,
        knownTitles: [...new Set([...listWorkspace().map((d) => d.name), ...(await knownTitles())])],
        modelAvailable: !failure && candidates.length > 0,
        kbUnavailable,
        focusName: chips.find((c) => c.kind === 'file')?.name ?? null,
      });
      const trace = describeTrace({ query: q.text, method, hits: used, engineLabel: t('engine.label_synthesizer'), durationMs });
      removeLoading();
      messageEl = placed(appendMessage('assistant', text, { citations: scope, badge: 'engine.label_synthesizer', trace, durationMs }));
    }
    const answerText = text;
    // An answer quoted without a model can list the files in the workspace: their names stay on this device.
    const namesWorkspace = engine === 'synthesizer' && listWorkspace().some((d) => answerText.includes(d.name));
    const localOnly = deviceOnly || usesWorkspace || namesWorkspace;
    const coverage = engine === 'synthesizer' ? citationList.map((c) => ({ delivered: /** @type {const} */ ('full'), text: c.text })) : coverageOf(citationList, delivered);
    const checkMixed = mixed && engine !== 'synthesizer';
    const answerLabel = checkMixed ? 'mixed' : webFound.length ? 'web' : 'grounded';
    const excerpts = gateSources(citationList, coverage);
    /** @type {any} */
    let report = null;
    /** @type {string | undefined} */
    let receiptId;
    if (messageEl && scope) {
      // The label says "checking…" while the source check runs after the stream.
      renderAnswerLabel(messageEl, answerLabel, { checking: true });
      await nextPaint();
      const checkSources = citationList.map((c, i) => ({ label: c.label, doc: c.doc, heading: c.heading, text: coverage[i].text, delivered: coverage[i].delivered }));
      // What the user said may be repeated without a source; the model's own earlier answers may not.
      const given = [q.text, ...history.slice(-4).filter((h) => h.role === 'user').map((h) => nodeText(h))];
      report = checkMixed
        ? applyMixedMarks(messageEl, { scope, sources: checkSources, given })
        : applyGrounding(messageEl, {
            scope,
            sources: checkSources,
            given,
            citedOnly: engine === 'synthesizer',
            // The AI judge of the second opinion sends statements and excerpts to a provider: only for
            // answers that may leave this device.
            localOnly,
          });
      renderAnswerLabel(messageEl, answerLabel);
      // A receipt vouches for passages a verifier can read again, from the workspace or the library.
      // A web passage is what the search said about a page, not the page, and the receipt format has
      // no place for it: an answer that rests on web pages is checked and labelled, without a receipt.
      if (!citationList.some((c) => c.source === 'web')) {
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
              // Only library and workspace passages reach this point (see above).
              source: c.source === 'workspace' ? 'workspace' : 'knowledge',
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
        const gate = await gateCounts(answerText, excerpts);
        if (gate) draft.gate = gate;
        // The relations the source check found across statements (comparisons, order in time, values
        // carried over). Second opinions are asked for after the answer, with the buttons of the
        // source check, and land in the report; the receipt reads them from there when it is built.
        if (report) {
          const { relations } = receiptAdvisory(report);
          if (relations.length) draft.relations = relations;
        }
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
    }
    const target = run?.target ?? null;
    const result = run?.result;
    const trace = describeTrace({ query: q.text, method, hits: used, engineLabel: target ? t(...badgeArgs(target, result?.model ?? target.model)) : t('engine.label_synthesizer'), durationMs, note: run && result ? attemptNote(run.attempts, result) : failure });
    const db = await store();
    const answerId = crypto.randomUUID();
    ownNode(answerId);
    const node = await db.appendNode(turnConversation(), {
      id: answerId,
      parentId: question.id,
      role: 'assistant',
      parts: [{ type: 'text', text: answerText }],
      opaque: target && result ? result.opaque : [],
      model: target && result ? result.model : null,
      provider: target && result ? result.provider : null,
      label: answerLabel,
      usage: target && result ? usageOf(result) : null,
      sources,
      localOnly,
      ...(report ? { grounding: { algorithm: report.algorithm, counts: report.counts, crossLanguage: report.crossLanguage, skipped: report.skipped } } : {}),
      meta: {
        engine,
        chat_mode: 'grounded',
        ...(answerLabel !== 'grounded' ? { answer_label: answerLabel } : {}),
        ...(q.reasons?.length ? { route_reasons: q.reasons.slice(0, 8) } : {}),
        thoughts: trace,
        duration_ms: durationMs,
        ...(target ? { requested: target.model, route: target.route, stop_reason: signal.aborted ? 'cancelled' : result?.stopReason } : {}),
        ...(result?.reasoning ? { reasoning: result.reasoning.slice(0, REASONING_CHARS) } : {}),
      },
    });
    await reload();
    keepReadable(node.id, { label: 'grounded', sources: excerpts, grounding: null });
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
  const own = { conversationId, thread: current, left: false, live: /** @type {HTMLElement | null} */ (null), foreign: false };
  turn = own;
  setBusy(true);
  try {
    await fn(controller.signal);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      // The text comes from i18n only; what went wrong is in the console.
      console.warn('[starpi] the answer failed', err);
      turnNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.error_title', body: err instanceof Error && err.name === 'StoreError' ? 'chat-thread.notice.store_failed' : 'chat-thread.notice.failed_body' });
    }
  } finally {
    controller = null;
    turn = null;
    setBusy(false);
  }
  if (own.conversationId !== conversationId) return;
  // Changed elsewhere during the turn (the sync, another tab): deleted, it returns to a new chat;
  // otherwise, as when the chat on screen changed during the turn, it shows what is stored now.
  if (own.foreign) await followShown();
  else if (own.left) await showConversation(conversationId);
  else shown = shownSignature(current);
}

/**
 * Whether a model choice can answer a question that stays on this device: the model here, or a
 * choice that reaches the model here or the own server.
 * @param {AssistantValue} value
 */
export async function answersHere(value) {
  return value === 'device' || (await chatCandidates(value)).some(onThisDevice);
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

/** Whether the note about a model that cannot search the web was shown on this page. */
let webNoticeShown = false;

/**
 * Auto's decision for a question (ai/hybrid.js): what it carries and names, the workspace probe,
 * a route decider registered with setRouteDecider (it can only tighten the route), whether a model
 * is set up, and the Web toggle with the first model's own search or the search API. Within a
 * conversation scoped to some workspace documents (setWorkspaceScope: a project's files) only those
 * are probed and named, as only those are searched.
 * @param {string} question
 * @param {import('../config.js').ChatMode} mode
 * @param {Array<{ name: string, kind: string }>} attachments
 * @param {AssistantValue} value
 */
async function routeFor(question, mode, attachments, value) {
  // An explicit mode needs no candidates: it is kept as it is.
  const candidates = mode === 'auto' ? await chatCandidates(value) : [];
  const native = Boolean(candidates[0] && searchesWeb(candidates[0]));
  const deviceOnly = value === 'device';
  const webOn = getWebSearch();
  const titles = mode === 'auto' ? await libraryTitles() : [];
  const scope = mode === 'auto' && single.scope ? await Promise.resolve(single.scope(turnConversation())).catch(() => null) : null;
  const scoped = scope?.length ? new Set(scope) : null;
  const files = mode === 'auto' ? listWorkspace().filter((d) => !scoped || scoped.has(d.docId)) : [];
  return decideRoute({
    question,
    mode,
    attachments,
    workspaceProbe: (q) => workspaceProbe(q, 5, scoped ? { docIds: [...scoped] } : {}),
    hooks: { classify: single.route ? async (q) => (await single.route?.({ question: q, mode, attachments, workspaceDocs: files.length })) ?? null : null },
    names: [...files.map((d) => d.name), ...(titles ?? [])],
    titles: titles ?? [],
    // Without a file here or a library document that can be listed, Auto stays free: there is
    // nothing the question's words could point at. A library that could not be listed (not
    // offline) may hold documents: then the rules that look for them apply.
    documents: titles === null ? undefined : files.length + titles.length,
    modelReady: mode !== 'auto' || value === 'device' || candidates.length > 0,
    deviceOnly,
    web: { on: webOn, native, searchApi: mode === 'auto' && webOn && !native && !deviceOnly ? Boolean(await browserWebSearch(getLocale())) : false },
  });
}

/**
 * The notes for the request of a free question being answered (registerRequestNotes), asked once
 * per answer and never stored: none for "Continue", which asks for the rest of an answer.
 * @param {NodeRecord} question
 * @param {TurnContext} ctx
 * @returns {Promise<string[]>}
 */
async function requestNotesFor(question, ctx) {
  if (metaOf(question).continue) return [];
  /** @type {string[]} */
  const notes = [];
  for (const hook of requestNoteHooks) {
    try {
      notes.push(...(await hook(ctx)));
    } catch (err) {
      console.warn('[starpi] a request note hook failed', err);
    }
  }
  return notes.slice(0, 8);
}

/**
 * Sends the composer's draft (or a given question).
 * @param {{ text?: string, chatMode?: 'grounded' | 'free', workspaceOnly?: boolean, localOnly?: boolean, docIds?: readonly string[] }} [options]
 *   text: a question from elsewhere (quick prompts); chatMode: answer it this way (the mode control
 *   switches along, so it shows what this question does); localOnly: the question carries content
 *   that stays on this device (a canvas document from such an answer): it goes the free route, is
 *   stored as staying here and only the model here or the own server answers it (with another
 *   model chosen it is not even stored); docIds: a grounded question searches only these workspace
 *   documents (an entity of the knowledge graph found only in some files)
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
  const value = getAssistant();
  const deviceOnly = options.localOnly === true;
  if (deviceOnly && !(await answersHere(value))) {
    appendNotice(STAYS_ON_DEVICE);
    return;
  }
  if (options.text === undefined) clearComposer();
  if (options.chatMode === 'grounded' && getChatMode() !== 'grounded' && !deviceOnly) setChatMode('grounded');
  const mode = options.chatMode ?? getChatMode();
  const kinds = draft.attachments.map((a) => ({ name: a.name, kind: a.kind }));
  // A question that stays on this device (an AI edit of such a canvas document) goes the free route here.
  const decision = options.chatMode || deviceOnly ? null : await routeFor(draft.text, mode, kinds, value);
  const route = deviceOnly ? 'free' : (options.chatMode ?? (decision?.route === 'free' || decision?.route === 'mixed' ? decision.route : 'grounded'));
  if (decision?.reasons.includes('web_unavailable') && !webNoticeShown) {
    webNoticeShown = true;
    appendNotice({ icon: 'info', tone: 'info', title: 'answers.notice.web_unavailable_title', body: 'answers.notice.web_unavailable_body' });
  }
  const onlyImages = draft.attachments.length > 0 && draft.attachments.every((a) => a.kind === 'image');
  const text =
    draft.text ||
    (onlyImages ? t('chat-thread.describe_images', { n: draft.attachments.length }) : draft.attachments.length === 1 ? t('chat.summarize_file', { name: draft.attachments[0].name }) : t('chat-thread.summarize_files', { n: draft.attachments.length }));
  await withTurn(async (signal) => {
    if (route !== 'free') {
      const web = decision?.retrieval.sources.includes('web') ?? false;
      const docIds = options.docIds?.filter((d) => typeof d === 'string' && d).slice(0, 50);
      await answerGrounded({ text, attachments: draft.attachments, parentId: leafId(), value, workspaceOnly: options.workspaceOnly === true, mode: route, web, reasons: decision?.reasons, ...(docIds?.length ? { docIds } : {}) }, signal);
      return;
    }
    /** @type {TurnContext} */
    const ctx = { conversationId: turnConversation(), question: text, mode, route: 'free', target: null, locale: getLocale(), attachments: kinds };
    const question = await storeQuestion({ text, attachments: draft.attachments, parentId: leafId(), route: 'free', localOnly: value === 'device' || deviceOnly, context: await contextFor(ctx) });
    if (onScreen()) renderNode(question);
    const answer = await answerFree(question, value, signal);
    if (answer && turnThread()?.path.length === 2) void nameConversation(turnConversation(), text, answer);
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
  // A question asked to stay on this device is answered again here or by the own server only.
  if (staysOnDevice(question) && !(await answersHere(target))) {
    appendNotice(STAYS_ON_DEVICE);
    return;
  }
  await withTurn(async (signal) => {
    const db = await store();
    // The path to the question is the thread now; the new answer becomes its newest child.
    await db.setActiveLeaf(turnConversation(), question.id);
    await reload();
    if (onScreen()) removeFrom(nodeId);
    let answer = null;
    try {
      answer =
        route === 'grounded'
          ? await answerGrounded({ text: nodeText(question), attachments: [], parentId: question.parentId, value: target, workspaceOnly: false, question, mode: node.label === 'mixed' ? 'mixed' : 'grounded', web: node.label === 'web' }, signal)
          : await answerFree(question, target, signal);
    } finally {
      // No new answer: the one before stays the thread.
      if (!answer) {
        await db.setActiveLeaf(turnConversation(), nodeId);
        await reload();
        const old = turnThread()?.tree.byId.get(nodeId);
        if (old && onScreen()) renderNode(old);
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
  // An edited question that stays on this device (like the one it replaces) is answered here or by
  // the own server only.
  if (staysOnDevice(node) && !(await answersHere(value))) {
    appendNotice(STAYS_ON_DEVICE);
    return;
  }
  const reuse = node.parts.filter((p) => p.type !== 'text');
  await withTurn(async (signal) => {
    removeFrom(nodeId);
    if (route === 'grounded') {
      await answerGrounded({ text, attachments: [], reuseParts: reuse, parentId: node.parentId, value, workspaceOnly: false, held: staysOnDevice(node) }, signal);
    } else {
      /** @type {TurnContext} */
      const ctx = { conversationId: turnConversation(), question: text, mode: getChatMode(), route: 'free', target: null, locale: getLocale(), attachments: chipsOf(node) };
      const question = await storeQuestion({ text, attachments: [], reuseParts: reuse, parentId: node.parentId, route: 'free', localOnly: node.localOnly, context: await contextFor(ctx) });
      if (onScreen()) renderNode(question);
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
  if (!node || node.role !== 'assistant' || leafId(current) !== node.id) return;
  const value = sameModel(node);
  await withTurn(async (signal) => {
    /** @type {TurnContext} */
    const ctx = { conversationId: turnConversation(), question: '', mode: getChatMode(), route: 'free', target: null, locale: getLocale(), attachments: [] };
    const question = await storeQuestion({ text: t('chat-thread.continue_prompt'), attachments: [], parentId: node.id, route: 'free', localOnly: node.localOnly, context: await contextFor(ctx), continueOf: true });
    if (onScreen()) renderNode(question);
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

// ---------------------------------------------------------------------------------------------
// Answers written outside the thread (the side-by-side compare, the council)
// ---------------------------------------------------------------------------------------------

/**
 * A question to ask several models outside the thread.
 * @typedef {object} PreparedQuestion
 * @property {NodeRecord} question  the stored question, or a new one that is not stored yet
 * @property {boolean} stored
 * @property {boolean} staysOnDevice  only the model here or the own server may answer it
 * @property {(target: Target) => Promise<AiRequest>} build  the request for one model, as the thread's free route sends it
 * @property {TurnContext} ctx  the question as the hooks see it (the tool runner of an answer reads it)
 */

/**
 * Prepares a question for several models, as a free question of the thread goes out: the stable
 * system prompt, the conversation up to the question (turns that stay on this device only for the
 * models here) and the question with its context block. `questionId` takes a stored question (its
 * own context block goes along); `text` makes a new one after `parentId` (default: the newest
 * message of the conversation) with a fresh context block, kept on its meta, so storing it later
 * keeps what went out. The notes for the request (registerRequestNotes: saved notes while memory is
 * on; none for "Continue") are asked once and go to every model, as the thread sends them with its
 * own answer. A question that stays on this device builds no request for other models (the error's
 * code is 'stays_on_device').
 * @param {{ conversationId: string, questionId?: string, text?: string, parentId?: string | null, localOnly?: boolean }} input
 * @returns {Promise<PreparedQuestion>}
 */
export async function prepareQuestion(input) {
  const loaded = await (await store()).loadThread(input.conversationId);
  const tree = loaded?.tree ?? indexNodes([]);
  /** @type {NodeRecord} */
  let question;
  /** @type {NodeRecord[]} */
  let path;
  /** @type {TurnContext} */
  const ctx = { conversationId: input.conversationId, question: '', mode: getChatMode(), route: 'free', target: null, locale: getLocale(), attachments: [] };
  if (input.questionId) {
    const found = tree.byId.get(input.questionId);
    if (!found || found.role !== 'user') throw Object.assign(new Error('No such question'), { code: 'not_found' });
    question = found;
    path = pathTo(tree, found.id);
  } else {
    const text = String(input.text ?? '').trim().slice(0, LIMITS.chatInputChars);
    if (!text) throw Object.assign(new Error('An empty question'), { code: 'empty' });
    const parentId = input.parentId !== undefined ? input.parentId : (loaded?.path.at(-1)?.id ?? null);
    const context = await contextFor({ ...ctx, question: text });
    question = {
      id: `draft-${crypto.randomUUID()}`,
      conversationId: input.conversationId,
      parentId,
      role: 'user',
      parts: [{ type: 'text', text }],
      opaque: [],
      model: null,
      provider: null,
      label: null,
      usage: null,
      localOnly: input.localOnly === true,
      createdAt: Date.now(),
      meta: { chat_mode: 'free', context },
    };
    path = [...(parentId ? pathTo(tree, parentId) : []), question];
  }
  const asked = question;
  /** @type {TurnContext} */
  const turnCtx = { ...ctx, question: nodeText(asked), attachments: chipsOf(asked) };
  /** @type {Promise<string[]> | null} */
  let notes = null;
  return {
    question: asked,
    stored: Boolean(input.questionId),
    staysOnDevice: asked.localOnly,
    ctx: turnCtx,
    build: async (target) => {
      // Grounded questions about the workspace stay on this device as well, whatever route asks them.
      if (asked.localOnly && !onThisDevice(target)) throw Object.assign(new Error('The question stays on this device'), { code: 'stays_on_device' });
      notes ??= requestNotesFor(asked, turnCtx);
      return freeRequest(target, path, { ...turnCtx, target }, await notes);
    },
  };
}

/**
 * A free answer written outside the thread, as the thread stores its own (the badge, the usage
 * line, the reasoning, the web pages, the web check and its label read it; no provider state for
 * an answer that stopped with tool calls left open). `meta` adds to the stored meta.
 * @param {{ question: NodeRecord, target: Target, result: CompletionResult, durationMs: number, aborted?: boolean, meta?: Record<string, unknown> }} input
 * @returns {Omit<import('./store.js').NodeInput, 'parentId'>}
 */
export function freeAnswerInput(input) {
  const { question, target, result, durationMs } = input;
  const fields = freeAnswerFields(result, { question: metaOf(question).continue ? '' : nodeText(question), locale: getLocale() });
  const badge = answerBadge({ provider: target.provider, model: result.model, meta: { requested: target.model, route: target.route } });
  return {
    role: 'assistant',
    parts: [{ type: 'text', text: result.text }],
    opaque: fields.opaque,
    model: result.model,
    provider: result.provider,
    label: fields.label,
    usage: usageOf(result),
    localOnly: target.route === 'device' || question.localOnly,
    meta: {
      engine: engineOf(target),
      chat_mode: 'free',
      requested: target.model,
      route: target.route,
      duration_ms: durationMs,
      stop_reason: input.aborted ? 'cancelled' : result.stopReason,
      thoughts: describeChatTrace({ engineLabel: t(badge.badge, badge.badgeParams), durationMs, attachment: chipsOf(question).map((c) => c.name).join(', ') || null }),
      ...(result.reasoning ? { reasoning: result.reasoning.slice(0, REASONING_CHARS) } : {}),
      ...fields.meta,
      ...(input.meta ?? {}),
    },
  };
}

/**
 * Stores an answer written outside the thread as the newest branch under its question (a question
 * that is not stored yet is stored first, in a conversation created when it is new) and shows it
 * when its chat is on screen. Refused (null) while the thread writes an answer.
 * @param {{ conversationId: string, question: NodeRecord, stored: boolean, answer: Omit<import('./store.js').NodeInput, 'parentId'> }} input
 * @returns {Promise<NodeRecord | null>}
 */
export async function adoptAnswer(input) {
  if (busy) return null;
  const db = await store();
  let questionId = input.question.id;
  if (!input.stored) {
    if (!(await db.getConversation(input.conversationId))) await db.createConversation({ id: input.conversationId, mode: getChatMode(), model: getAssistant() });
    const q = input.question;
    questionId = crypto.randomUUID();
    ownNode(questionId);
    await db.appendNode(input.conversationId, { id: questionId, parentId: q.parentId, role: 'user', parts: q.parts, localOnly: q.localOnly, ...(q.meta ? { meta: q.meta } : {}) });
  }
  const answerId = input.answer.id ?? crypto.randomUUID();
  ownNode(answerId);
  const node = await db.appendNode(input.conversationId, { ...input.answer, id: answerId, parentId: questionId });
  if (input.conversationId === conversationId) await showConversation(conversationId);
  return node;
}

/**
 * Labels an answer shown outside the thread (a compare column) as the thread labels its own: the
 * provenance label, a stop before the end, the web pages it cites, the registered decorations.
 * @param {HTMLElement} el  needs a .message-provenance slot
 * @param {NodeRecord} node  the stored answer, or one as it would be stored
 */
export function presentAnswer(el, node) {
  labelAnswer(el, node);
  decorateAnswer(el, node);
}

// ---------------------------------------------------------------------------------------------
// Live voice turns (voice/hooks.js registerVoiceUi: ask, retrieve)
// ---------------------------------------------------------------------------------------------

/** Output limit of a spoken answer. */
const SPOKEN_ANSWER_TOKENS = 700;

/**
 * The request of a spoken turn for one model: the spoken prompt (free, or the source rules with
 * the turn's excerpts), the earlier turns of the Live session, and what was said (with a camera
 * picture for a model that can see).
 * @param {Target} target
 * @param {LiveTurn} turn
 * @returns {AiRequest}
 */
export function liveRequest(target, turn) {
  const locale = /** @type {import('../i18n/index.js').Locale} */ (turn.locale.slice(0, 2) === 'de' ? 'de' : 'en');
  const caps = capsOf(target.provider, target.model);
  const who = target.route === 'device' ? 'local' : target.route === 'local' ? 'server' : 'cloud';
  /** @type {string | null} */
  let context = null;
  if (turn.mode === 'grounded') {
    const excerpts = turn.sources.map((s) => ({ label: s.label, heading: '', text: s.text }));
    context = buildContext(/** @type {any} */ (excerpts), { maxChars: LIMITS.contextCharsCloud });
  }
  /** @type {Message[]} */
  const messages = turn.history.slice(-12).map((h) => ({ role: h.role, content: [{ type: /** @type {const} */ ('text'), text: h.text }] }));
  /** @type {Part[]} */
  const content = [{ type: 'text', text: turn.text }];
  if (turn.image && caps.vision) content.push({ type: 'image', mime: turn.image.mime, data: turn.image.data });
  messages.push({ role: 'user', content });
  /** @type {AiRequest} */
  let req = { provider: target.provider, model: target.model, system: spokenSystemPrompt({ locale, who, context }), messages, temperature: 0.3, ...(target.route === 'device' ? {} : { maxOutputTokens: Math.min(caps.maxOutput || SPOKEN_ANSWER_TOKENS, SPOKEN_ANSWER_TOKENS) }) };
  if (target.route === 'pool') {
    const fitted = fitPoolRequest({ system: req.system, messages: req.messages });
    req = { ...req, system: fitted.system, messages: fitted.messages };
  }
  return req;
}

/**
 * A Live turn through the chat's model choice (the picker's value, the same order and fallbacks as
 * a typed question); yields the answer's text deltas. Without a model it fails with the code
 * 'no_model', after a failed call with the call's error code.
 * @param {LiveTurn} turn
 * @returns {AsyncGenerator<string>}
 */
export async function* liveAnswer(turn) {
  const candidates = await chatCandidates(getAssistant(), { vision: Boolean(turn.image) });
  if (!candidates.length) throw Object.assign(new Error('no model'), { code: 'no_model' });
  /** @type {string[]} */
  const queue = [];
  /** @type {(() => void) | null} */
  let wake = null;
  let done = false;
  /** @type {string | null} */
  let failure = null;
  const nudge = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };
  void runAnswer({
    candidates,
    signal: turn.signal,
    build: (target) => liveRequest(target, turn),
    onEvent: (ev) => {
      if (ev.type !== 'text') return;
      queue.push(ev.delta);
      nudge();
    },
  })
    .then(
      (run) => {
        if (run.result.error && !turn.signal.aborted) failure = run.result.error.code;
      },
      (err) => {
        if (!turn.signal.aborted) failure = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
      },
    )
    .finally(() => {
      done = true;
      nudge();
    });
  for (;;) {
    if (queue.length) {
      yield /** @type {string} */ (queue.shift());
      continue;
    }
    if (done) break;
    await new Promise((resolve) => {
      wake = () => resolve(undefined);
    });
  }
  if (failure) throw Object.assign(new Error(failure), { code: failure });
}

/**
 * Excerpts for a source Live turn, retrieved as a typed grounded question would be (the workspace,
 * and the knowledge base unless the picker keeps questions on this device), within the context
 * budget of a cloud answer.
 * @param {string} query
 * @returns {Promise<GateSource[]>}
 */
export async function liveSources(query) {
  const { hits } = await retrieve(query, [], { workspaceOnly: false, deviceOnly: getAssistant() === 'device' });
  /** @type {GateSource[]} */
  const out = [];
  let chars = 0;
  for (const c of assignCitations(hits, { excerptChars: LIMITS.excerptChars })) {
    if (chars + c.text.length > LIMITS.contextCharsCloud) break;
    chars += c.text.length;
    out.push({ index: out.length, label: c.label, text: c.text, kind: 'doc' });
  }
  return out;
}
