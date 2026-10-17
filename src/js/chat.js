// @ts-check
// Chat flow in two modes. Verified source mode: retrieval (on-device workspace BM25 + knowledge
// base) -> answer (cloud provider / on-device model / own server / NVIDIA cloud / extractive
// synthesizer) -> render with verifiable citations, the source check and a receipt -> persist. Free
// chat: the conversation and an attached file go to the configured model, without retrieval, source
// check or receipt.
import { currentSessionId, deleteSession, loadCurrentSession, persistMessage, refreshSyncStatus, startNewSession, switchSession } from './chat-store.js';
import { splitReasoning } from './chat-stream.js';
import { APP_VERSION, LIMITS } from './config.js';
import { contextCoverage } from './core/grounding.js';
import { byId, downloadText, onAction, onChange, setHidden } from './dom.js';
import { refreshIcons } from './icons.js';
import { startLocalEngine } from './engine-ui.js';
import { formatDate, getLocale, hasKey, setText, t } from './i18n/index.js';
import { appendLoading, appendMessage, appendNotice, createStreamingMessage, markFreeAnswer, resetMessages } from './messages.js';
import { findNvidiaModel, NVIDIA_LIMITS } from './models/nvidia-catalog.js';
import {
  attachmentSection,
  buildChatPrompt,
  buildInstructions,
  buildSystemPrompt,
  chatInstructions,
  contextSection,
  excerptForChat,
  fitNvidiaMessages,
  historyWindow,
} from './prompts.js';
import { callGemini, callLocalServer, callNvidia, callOpenRouter, getNvidiaCatalog, hasGeminiKey, hasOpenRouterKey, ProviderError, resolveNvidiaModel } from './providers.js';
import { registerCitations } from './rag/citations.js';
import { applyGrounding } from './rag/grounding-view.js';
import { receiptButton, storeReceiptDraft } from './rag/receipts.js';
import { libraryHitsByMeaning } from './rag/embed-client.js';
import { addToWorkspace, firstChunks, getDocumentText, listWorkspace, searchWorkspace } from './rag/workspace.js';
import { sanitizeModelNames } from './render.js';
import { assignCitations, buildContext, distinctSources, mergeHits, rankHitsLocally, workspaceHit } from './retrieval.js';
import { isUserAbort } from './signals.js';
import { getChatMode, getLlmUrl, getMode, getNvidiaModel, onChatModeChange, setChatMode } from './state.js';
import { getConnection, listDocuments, recentKnowledge, searchKnowledge } from './supabase.js';
import { describeChatTrace, describeTrace, isGreeting, synthesizeAnswer } from './synthesizer.js';
import { setAssistantStatus } from './ui.js';
import * as engine from './webgpu/engine.js';
import { budgetPrompt } from './webgpu/models.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./config.js').ChatMode} ChatMode */
/** @typedef {import('./config.js').ComputeMode} ComputeMode */
/** @typedef {import('./providers.js').ChatMessage} ChatMessage */

/**
 * A turn of the conversation. `content` is what a model gets as history; `shown` is the question as
 * the chat showed it (with the name of an attached file).
 * @typedef {object} Turn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {boolean} [localOnly]  stays on this device: never sent to a provider or server as history
 * @property {string} [shown]
 * @property {string} [createdAt]   ISO time
 * @property {string} [engine]      engine id of an answer
 * @property {string} [model]       model id of an answer, when known
 * @property {ChatMode} [chatMode]
 */

/** i18n keys of the engine that produced an answer (stored with the message as `engine`). */
const ENGINE_LABELS = /** @type {Record<string, string>} */ ({
  cloud: 'engine.label_cloud',
  client: 'engine.label_client',
  wasm: 'engine.label_wasm',
  local: 'engine.label_server',
  nvidia: 'engine.label_nvidia',
  synthesizer: 'engine.label_synthesizer',
});

/** History sent with a question in source mode: the last four turns, as before. */
const GROUNDED_WINDOW = Object.freeze({ turns: 4, turnChars: Infinity, totalChars: Infinity });
/** History sent with a question in the free chat: a longer conversation within a size budget. */
const FREE_WINDOW = Object.freeze({ turns: LIMITS.freeHistoryTurns, turnChars: LIMITS.historyTurnChars, totalChars: LIMITS.freeHistoryChars });
/** The trace of a free answer has one phase after the model's own reasoning: the answer. */
const FREE_TRACE_ROLES = ['trace.role_answer'];

/** @type {Turn[]} */
let conversation = [];
let busy = false;
/** @type {AbortController | null} */
let activeAbort = null;
/** @type {{ docId: string, name: string } | null} */
let attachment = null;
/** Counts attachment changes, so a file that finishes reading after it was removed is ignored. */
let attachSeq = 0;
/** @type {Promise<void> | null} */
let attaching = null;
/** @type {{ at: number, titles: string[] } | null} */
let titlesCache = null;

export function invalidateKnownTitles() {
  titlesCache = null;
}

/** Clears the conversation on screen and in memory (new chat, deleted history). */
export function resetConversation() {
  conversation = [];
  resetMessages();
  setAssistantStatus('status.ready');
}

export function isChatBusy() {
  return busy;
}

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
 * Workspace chunks for the question; a just-attached file always contributes (its best chunks, or
 * its first chunks when nothing in it matches, e.g. "summarize this file") and comes first.
 * @param {string} query
 * @param {string | null} focusDocId
 * @returns {Promise<{ hits: KnowledgeHit[], pinned: number }>}
 */
async function retrieveWorkspace(query, focusDocId) {
  try {
    const found = await searchWorkspace(query, LIMITS.retrievalRows);
    if (!focusDocId) return { hits: found.map(workspaceHit), pinned: 0 };
    const inFile = found.filter((h) => h.docId === focusDocId);
    const focus = inFile.length ? inFile.slice(0, 3) : await firstChunks(focusDocId, 3);
    const others = found.filter((h) => h.docId !== focusDocId);
    return { hits: [...focus, ...others].map(workspaceHit), pinned: focus.length };
  } catch (err) {
    console.warn('[starpi] workspace search failed', err);
    return { hits: [], pinned: 0 };
  }
}

/**
 * @param {string} query
 * @param {import('./config.js').ComputeMode} mode
 * @param {string | null} focusDocId
 * @param {boolean} workspaceOnly  a question about the files in the workspace (the sample questions)
 * @returns {Promise<{ hits: KnowledgeHit[], method: string, kbUnavailable: boolean }>}
 */
async function retrieve(query, mode, focusDocId, workspaceOnly) {
  const { hits: local, pinned } = await retrieveWorkspace(query, focusDocId);
  const limit = LIMITS.retrievalRows + (focusDocId ? 3 : 0);
  const merge = (/** @type {KnowledgeHit[]} */ remote) => mergeHits(local, remote, limit, pinned);
  const join = (/** @type {KnowledgeHit[]} */ hits, /** @type {string} */ remote) => {
    const n = hits.filter((h) => h.workspace).length;
    return [n ? t('retrieval.workspace', { n }) : '', remote].filter(Boolean).join(' + ');
  };
  const result = (/** @type {KnowledgeHit[]} */ hits, /** @type {string} */ remote, /** @type {boolean} */ kbUnavailable) => ({
    hits,
    method: join(hits, remote),
    kbUnavailable,
  });

  if (workspaceOnly) return result(local.slice(0, limit), '', false);

  // While Supabase is known to be unreachable, answer from the workspace at once instead of waiting
  // for requests to time out; the connection is retried in the background (supabase.js).
  if (getConnection().status === 'offline') return result(merge([]), t('retrieval.offline'), true);

  if (mode !== 'client') {
    const search = await searchKnowledge(query);
    if (search.ok && search.data.length > 0) return result(merge(search.data), t('retrieval.fts'), false);
    const recent = await recentKnowledge(30);
    const why = search.ok ? 'retrieval.why_no_match' : search.error.kind === 'missing_function' ? 'retrieval.why_missing' : 'retrieval.why_unavailable';
    if (!recent.ok) return result(merge([]), t('retrieval.offline'), true);
    const ranked = rankHitsLocally(query, recent.data, LIMITS.retrievalRows);
    return result(merge(ranked), t('retrieval.keyword', { why: t(why) }), false);
  }

  // Local mode: with semantic search on, the library is ranked by the question's vector (made on
  // this device; the text stays here). Otherwise candidates are fetched without the question and
  // ranked in the browser.
  const byMeaning = await libraryHitsByMeaning(query, LIMITS.retrievalRows);
  if (byMeaning?.length) return result(merge(byMeaning), t('workspace.retrieval_vector'), false);
  const recent = await recentKnowledge(30);
  const ranked = recent.ok ? rankHitsLocally(query, recent.data, LIMITS.retrievalRows) : [];
  return result(merge(ranked), t(recent.ok ? 'retrieval.local' : 'retrieval.offline'), !recent.ok);
}

/**
 * @typedef {object} Answer
 * @property {string} text
 * @property {'cloud' | 'client' | 'wasm' | 'local' | 'nvidia' | 'synthesizer'} engine
 * @property {string} [model] id of the model that answered, when known
 * @property {boolean} [rendered] already rendered by a streaming bubble
 * @property {HTMLElement} [element] the message element of a streamed answer
 * @property {string} [deliveredContext] the context actually sent, when it was trimmed to fit the model
 * @property {string} [note] why the configured model gave no answer (shown as a notice)
 * @property {boolean} [notConfigured] the configured model is not set up (rather than failing)
 * @property {string} [traceNote] about an answer that did arrive (cut off, another model): details only
 */

/**
 * What goes into the system prompt: the retrieved excerpts (source mode), or an attached file
 * (free chat).
 * @typedef {{ kind: 'grounded', context: string } | { kind: 'free', attachment: { name: string, text: string } | null }} PromptPlan
 */

/**
 * @typedef {object} AnswerRequest
 * @property {PromptPlan} plan
 * @property {string} prompt
 * @property {Turn[]} history
 * @property {AbortSignal} signal
 * @property {number} started             performance.now() when the question was sent
 * @property {() => void} removeLoading
 * @property {string | null} citations    citation scope of the excerpts (source mode)
 * @property {string} query
 * @property {string} method              how the excerpts were found (source mode)
 * @property {KnowledgeHit[]} hits
 */

/**
 * The newest turns that may leave the device: turns that stayed on it (on-device mode, workspace
 * excerpts, attached files) are never sent to a cloud provider or a server as history.
 * @param {Turn[]} history
 * @param {{ turns: number, turnChars: number, totalChars: number }} limits
 */
function shareableHistory(history, limits) {
  return historyWindow(history.filter((h) => !h.localOnly), limits);
}

/**
 * System prompt, shareable history and question for a model that does not run on this device.
 * @param {AnswerRequest} req
 * @param {'cloud' | 'server'} target
 * @returns {ChatMessage[]}
 */
function remoteMessages(req, target) {
  const locale = getLocale();
  const { plan } = req;
  const system = plan.kind === 'free' ? buildChatPrompt({ locale, target, attachment: plan.attachment }) : buildSystemPrompt({ locale, target, context: plan.context });
  return [{ role: 'system', content: system }, ...shareableHistory(req.history, plan.kind === 'free' ? FREE_WINDOW : GROUNDED_WINDOW), { role: 'user', content: req.prompt }];
}

/**
 * The trace stored with an answer: retrieval and answer in source mode, the answer alone in free chat.
 * @param {AnswerRequest} req
 * @param {string} engineLabel
 * @param {number} durationMs
 * @param {string} [note]
 */
function traceFor(req, engineLabel, durationMs, note) {
  const { plan } = req;
  return plan.kind === 'free'
    ? describeChatTrace({ engineLabel, durationMs, attachment: plan.attachment?.name ?? null, note })
    : describeTrace({ query: req.query, method: req.method, hits: req.hits, engineLabel, durationMs, note });
}

/**
 * The label of the engine that answered, as an i18n key with parameters: a model name is only ever
 * a parameter, never part of a key. NVIDIA models are named as the bundled catalog names them.
 * @param {string | undefined} engineId
 * @param {string | undefined} model
 * @returns {{ badge: string, badgeParams: Record<string, string> | undefined }}
 */
function engineLabel(engineId, model) {
  const name = model && engineId === 'nvidia' ? (findNvidiaModel(model)?.label ?? model) : model;
  return { badge: (engineId && ENGINE_LABELS[engineId]) || '', badgeParams: name ? { model: name } : undefined };
}

/**
 * @param {AnswerRequest} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithCloud(req) {
  const { plan } = req;
  /** @type {string | null} */
  let geminiFailure = null;
  if (hasGeminiKey()) {
    try {
      // Source mode sends one self-contained turn; the free chat sends the conversation.
      const r =
        plan.kind === 'free'
          ? await callGemini(req.prompt, {
              signal: req.signal,
              system: buildChatPrompt({ locale: getLocale(), target: 'cloud', attachment: plan.attachment }),
              history: shareableHistory(req.history, FREE_WINDOW),
            })
          : await callGemini(`${buildSystemPrompt({ locale: getLocale(), target: 'cloud', context: plan.context })}\n\n${t('prompt.user_question')}\n${req.prompt}`, { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      geminiFailure = sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160);
      console.warn('[starpi] Gemini failed, trying the next provider:', geminiFailure);
    }
  }
  if (hasOpenRouterKey()) {
    try {
      const r = await callOpenRouter(remoteMessages(req, 'cloud'), { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      const reason = sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160);
      return { text: '', engine: 'synthesizer', note: t('chat.note_cloud_failed', { reason }) };
    }
  }
  if (geminiFailure) return { text: '', engine: 'synthesizer', note: t('chat.note_cloud_failed', { reason: geminiFailure }) };
  return null;
}

/**
 * Engine id and output budgets of the loaded on-device model. A model without a runtime field is a
 * WebGPU preset; the free chat may answer longer, within a third of the context window.
 * @param {{ chatOptions: { context_window_size: number }, runtime?: 'webgpu' | 'wasm', maxOutputTokens?: number }} model
 */
function localModelProfile(model) {
  const wasm = model.runtime === 'wasm';
  const groundedTokens = model.maxOutputTokens ?? 512;
  return {
    engineId: /** @type {'client' | 'wasm'} */ (wasm ? 'wasm' : 'client'),
    groundedTokens,
    freeTokens: wasm ? groundedTokens : Math.min(768, Math.floor(model.chatOptions.context_window_size / 3)),
  };
}

/**
 * The system message for the on-device model. The context is fenced after budgeting, so trimming
 * never cuts its closing marker.
 * @param {PromptPlan} plan
 * @param {{ system: string, context: string }} budget
 */
function localSystemMessage(plan, budget) {
  const locale = getLocale();
  if (plan.kind === 'grounded') return `${budget.system}\n\n${contextSection(locale, budget.context)}`;
  if (!plan.attachment) return budget.system;
  return `${budget.system}\n\n${attachmentSection(locale, { name: plan.attachment.name, text: budget.context })}`;
}

/**
 * @param {AnswerRequest} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithLocalModel(req) {
  const ready = engine.isReady() || (await startLocalEngine({ interactive: true }));
  const model = engine.getEngineState().model;
  if (!ready || !model || req.signal.aborted) return null;

  const locale = getLocale();
  const { plan } = req;
  const free = plan.kind === 'free';
  const local = localModelProfile(model);
  const maxTokens = free ? local.freeTokens : local.groundedTokens;
  const budget = budgetPrompt({
    contextWindow: model.chatOptions.context_window_size,
    maxOutputTokens: maxTokens,
    system: plan.kind === 'free' ? chatInstructions(locale, 'local', plan.attachment !== null) : buildInstructions(locale, 'local'),
    context: plan.kind === 'free' ? (plan.attachment?.text ?? '') : plan.context,
    history: req.history.slice(free ? -LIMITS.freeHistoryTurns : -4),
    user: req.prompt,
    // A conversation keeps longer turns than the excerpt-heavy source mode.
    turnChars: free ? 2_000 : undefined,
  });

  req.removeLoading();
  const label = ENGINE_LABELS[local.engineId];
  const stream = createStreamingMessage(label);
  const onAbort = () => engine.interrupt();
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const text = await engine.generate({
      messages: [{ role: 'system', content: localSystemMessage(plan, budget) }, ...budget.history, { role: 'user', content: budget.user }],
      maxTokens,
      temperature: free ? 0.7 : 0.2,
      onDelta: (delta) => stream.update(delta),
    });
    if (!text.trim()) {
      stream.remove();
      return null;
    }
    const durationMs = Math.round(performance.now() - req.started);
    const trace = traceFor(req, t(label), durationMs);
    stream.finalize(text, { citations: req.citations, trace, durationMs, traceRoles: free ? FREE_TRACE_ROLES : undefined });
    return { text, engine: local.engineId, model: model.modelId, rendered: true, element: stream.element, deliveredContext: budget.context };
  } catch (err) {
    stream.remove();
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', engine: 'synthesizer', note: t('chat.note_local_failed', { reason: message }) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {AnswerRequest} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithOwnServer(req) {
  try {
    const r = await callLocalServer(getLlmUrl(), remoteMessages(req, 'server'), { signal: req.signal });
    return { text: r.text, engine: 'local' };
  } catch (err) {
    if (req.signal.aborted) throw err;
    return { text: '', engine: 'synthesizer', note: t('chat.note_server_failed', { reason: err instanceof Error ? err.message : String(err) }) };
  }
}

/**
 * A provider message as the reason in a notice, which adds its own full stop.
 * @param {unknown} err
 */
function reasonOf(err) {
  return (err instanceof Error ? err.message : String(err)).replace(/\.\s*$/, '');
}

/**
 * NVIDIA cloud through Starpi's proxy, streamed into a bubble. In source mode the answer then goes
 * through the same source check and receipt as every other engine. Messages follow the same rules as
 * other remote models (turns that stayed on this device are not sent) and are fitted to the proxy's
 * limits; the model's reasoning stays in the details.
 * @param {AnswerRequest} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithNvidia(req) {
  const catalog = await getNvidiaCatalog();
  if (!catalog.configured) {
    return { text: '', engine: 'synthesizer', notConfigured: true, note: reasonOf(t(catalog.reachable ? 'provider.nvidia_not_configured' : 'provider.nvidia_not_available')) };
  }
  const { model, replaced } = resolveNvidiaModel(catalog, getNvidiaModel());
  if (!model) return { text: '', engine: 'synthesizer', notConfigured: true, note: reasonOf(t('provider.nvidia_no_models')) };
  if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const { plan } = req;
  const free = plan.kind === 'free';
  const sent = remoteMessages(req, 'cloud');
  const messages = fitNvidiaMessages(sent, NVIDIA_LIMITS, LIMITS.historyTurnChars);
  const maxTokens = findNvidiaModel(model)?.defaultMaxTokens ?? catalog.models.find((m) => m.id === model)?.defaultMaxTokens ?? NVIDIA_LIMITS.defaultMaxTokens;
  const label = engineLabel('nvidia', model);

  req.removeLoading();
  const stream = createStreamingMessage(label.badge, label.badgeParams);
  try {
    const r = await callNvidia(messages, { model, maxTokens, temperature: free ? 0.7 : 0.2, signal: req.signal, onDelta: (text) => stream.update(text) });
    const modelName = label.badgeParams?.model ?? model;
    const traceNote = [r.truncated ? t('chat.note_truncated') : '', replaced ? t('chat.note_model_replaced', { model: modelName }) : ''].filter(Boolean).join(' ') || undefined;
    const durationMs = Math.round(performance.now() - req.started);
    const trace = traceFor(req, t(label.badge, label.badgeParams), durationMs, traceNote);
    stream.finalize(r.text, { citations: req.citations, trace, durationMs, traceRoles: free ? FREE_TRACE_ROLES : undefined });
    // The source check compares with what reached the model: a context cut to fit is passed on.
    const system = messages[0]?.role === 'system' ? messages[0].content : '';
    const cut = plan.kind === 'grounded' && sent[0]?.role === 'system' && system !== sent[0].content;
    return { text: r.text, engine: 'nvidia', model, rendered: true, element: stream.element, traceNote, deliveredContext: cut ? system : undefined };
  } catch (err) {
    stream.remove();
    if (req.signal.aborted) throw err;
    const notConfigured = err instanceof ProviderError && err.notConfigured;
    // The proxy lost its keys or is gone: ask again before the next question.
    if (notConfigured) void getNvidiaCatalog({ refresh: true });
    if (!(err instanceof ProviderError)) console.warn('[starpi] NVIDIA cloud answer failed', err);
    return { text: '', engine: 'synthesizer', notConfigured, note: err instanceof ProviderError ? reasonOf(err) : reasonOf(t('provider.nvidia_bad_response')) };
  }
}

/**
 * Asks the model of the current mode. null: no model answered (none is set up, or it is not
 * ready); an answer without text but with a note: a configured model failed.
 * @param {ComputeMode} mode
 * @param {AnswerRequest} req
 * @returns {Promise<Answer | null>}
 */
async function generateAnswer(mode, req) {
  switch (mode) {
    case 'council':
      return answerWithCloud(req);
    case 'client':
      return answerWithLocalModel(req);
    case 'local':
      return answerWithOwnServer(req);
    case 'nvidia':
      return answerWithNvidia(req);
  }
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  // Hiding the focused Stop button drops focus later, not at once: note it before hiding.
  const stopHadFocus = document.activeElement === byId('stopBtn');
  setHidden(byId('stopBtn'), !on);
  const send = /** @type {HTMLButtonElement | null} */ (byId('sendBtn'));
  const input = byId('chatInput');
  // Disabling the focused Send button would drop keyboard focus to <body>; keep it in the input.
  if (on && send && document.activeElement === send) input?.focus();
  if (send) send.disabled = on;
  if (!on && (stopHadFocus || document.activeElement === document.body)) input?.focus();
  byId('chatMessages')?.setAttribute('aria-busy', String(on));
  setAssistantStatus(on ? 'status.generating' : 'status.ready');
}

/**
 * One question on its way to an answer.
 * @typedef {object} Exchange
 * @property {string} prompt
 * @property {string} shownText       the question as shown (with the name of an attached file)
 * @property {string} askedAt         ISO time
 * @property {{ docId: string, name: string } | null} file  attached to this question
 * @property {string} sid             chat session the question belongs to
 * @property {Turn[]} history
 * @property {ComputeMode} mode
 * @property {boolean} localOnly      on-device mode: nothing of this turn leaves the device
 * @property {AbortSignal} signal
 * @property {number} started
 * @property {() => void} removeLoading
 * @property {(usesWorkspace: boolean) => void} storeQuestion
 * @property {boolean} workspaceOnly  search only the on-device workspace
 */

/**
 * @param {string} rawText
 * @param {{ workspaceOnly?: boolean, chatMode?: ChatMode }} [options]  workspaceOnly: search only the
 *   on-device workspace; chatMode: overrides the composer toggle (quick prompts ask the sources)
 */
export async function submitChat(rawText, options = {}) {
  if (busy) {
    setAssistantStatus('status.busy');
    return;
  }
  const userText = rawText.trim().slice(0, LIMITS.chatInputChars);
  // A file still being read belongs to this question: wait for it instead of sending without it.
  if (attaching) {
    busy = true;
    setAssistantStatus('status.reading_file');
    try {
      await attaching;
    } finally {
      busy = false;
      setAssistantStatus('status.ready');
    }
  }
  const file = attachment;
  if (!userText && !file) return;

  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  if (input) {
    input.value = '';
    autosize(input);
  }
  removeAttachment();

  const sid = currentSessionId();
  const history = conversation.slice();
  const mode = getMode();
  // A question about the sources (quick prompt, sample question, graph entity) runs in source mode
  // even when free chat is selected; the toggle and the privacy notice switch along, so they show
  // what this question does: search the sources and send the excerpts.
  if (options.chatMode === 'grounded' && getChatMode() !== 'grounded') setChatMode('grounded');
  const chatMode = options.chatMode ?? getChatMode();
  const localOnly = mode === 'client';
  const prompt = userText || t('chat.summarize_file', { name: file?.name ?? '' });
  const shownText = file ? `${prompt}\n\n[${file.name}]` : prompt;

  appendMessage('user', shownText);
  const askedAt = new Date().toISOString();
  // The question follows its answer's storage rule, so it is stored once retrieval shows whether
  // workspace excerpts are involved: a question about the workspace (or naming an attached file)
  // stays on this device like its answer.
  let questionStored = false;
  const storeQuestion = (/** @type {boolean} */ usesWorkspace) => {
    if (questionStored) return;
    questionStored = true;
    void persistMessage(sid, { role: 'user', content: shownText, sources: [], metadata: { chat_mode: chatMode } }, { localOnly: localOnly || Boolean(file) || usesWorkspace });
  };

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  const removeLoading = appendLoading(chatMode === 'free' ? 'chat.thinking_free' : 'chat.thinking');
  const started = performance.now();
  /** @type {Exchange} */
  const exchange = { prompt, shownText, askedAt, file, sid, history, mode, localOnly, signal: controller.signal, started, removeLoading, storeQuestion, workspaceOnly: options.workspaceOnly === true };

  try {
    await (chatMode === 'free' ? answerFree(exchange) : answerGrounded(exchange));
  } catch (err) {
    storeQuestion(false);
    removeLoading();
    if (!isUserAbort(err)) {
      appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.error_title', body: 'chat.error_body', params: { reason: err instanceof Error ? err.message : String(err) } });
    }
  } finally {
    removeLoading();
    setBusy(false);
    activeAbort = null;
  }
}

/**
 * Stored with an answer: the engine (and model) that produced it, the chat mode and the trace.
 * @param {Answer} answer
 * @param {ChatMode} chatMode
 * @param {string} trace
 * @param {number} durationMs
 */
function answerMetadata(answer, chatMode, trace, durationMs) {
  return { engine: answer.engine, ...(answer.model ? { model: answer.model } : {}), chat_mode: chatMode, thoughts: trace, duration_ms: durationMs };
}

/**
 * Adds a question and its answer to the conversation.
 * @param {Exchange} x
 * @param {Answer} answer
 * @param {string} answerText  the answer without the model's reasoning
 * @param {boolean} localOnly
 * @param {ChatMode} chatMode
 */
function pushTurns(x, answer, answerText, localOnly, chatMode) {
  conversation.push(
    { role: 'user', content: x.prompt.slice(0, 4_000), localOnly, shown: x.shownText, createdAt: x.askedAt, chatMode },
    { role: 'assistant', content: answerText, localOnly, createdAt: new Date().toISOString(), engine: answer.engine, model: answer.model, chatMode },
  );
}

/**
 * Verified source mode: retrieval, an answer from the model (or quoted from the sources), the
 * source check and a receipt draft, for every engine.
 * @param {Exchange} x
 */
async function answerGrounded(x) {
  const { prompt, file, sid, history, mode, localOnly, signal, started, removeLoading } = x;
  const { hits, method, kbUnavailable } = await retrieve(prompt, mode, file?.docId ?? null, x.workspaceOnly);
  const greeting = !file && isGreeting(prompt);
  const used = greeting ? [] : hits;
  const usesWorkspace = used.some((h) => h.workspace);
  x.storeQuestion(usesWorkspace);
  const citationList = assignCitations(used, { excerptChars: LIMITS.excerptChars });
  const citations = registerCitations(citationList);
  const sources = distinctSources(used);
  const context = buildContext(citationList, { maxChars: LIMITS.contextCharsCloud });

  /** @type {Answer | null} */
  let answer = await generateAnswer(mode, { plan: { kind: 'grounded', context }, prompt, history, signal, started, removeLoading, citations, query: prompt, method, hits: used });

  const note = answer?.note;
  if (note) {
    // A configured model failed: say so where the answer appears, not only in the details.
    appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.provider_failed_title', body: 'chat.provider_failed_body', params: { reason: note } });
  }
  if (!answer || !answer.text) {
    const modelAvailable = !note && (mode !== 'council' || hasGeminiKey() || hasOpenRouterKey());
    answer = {
      text: synthesizeAnswer({
        query: prompt,
        hits: used,
        citations: citationList,
        // Files in the on-device workspace are available documents too.
        knownTitles: [...new Set([...listWorkspace().map((d) => d.name), ...(await knownTitles())])],
        modelAvailable,
        kbUnavailable,
        focusName: file?.name ?? null,
      }),
      engine: 'synthesizer',
    };
  }
  if (signal.aborted && !answer.rendered) throw new DOMException('Aborted', 'AbortError');

  const durationMs = Math.round(performance.now() - started);
  const answerText = splitReasoning(answer.text).answer || answer.text;
  // An answer quoted without a model can list the files in the workspace (greeting, document list):
  // their names stay on this device like the files themselves.
  const namesWorkspace = answer.engine === 'synthesizer' && listWorkspace().some((d) => answerText.includes(d.name));
  const label = engineLabel(answer.engine, answer.model);
  const trace = describeTrace({ query: prompt, method, hits: used, engineLabel: t(label.badge, label.badgeParams), durationMs, note: note ?? answer.traceNote });

  if (sid === currentSessionId()) {
    /** @type {HTMLElement | null} */
    let messageEl = answer.element ?? null;
    if (!answer.rendered) {
      removeLoading();
      messageEl = appendMessage('assistant', answer.text, { citations, ...label, trace, durationMs });
    }
    if (messageEl && citations) {
      // Extractive answers quote the excerpts as given; model answers are checked against the part
      // of each excerpt that actually reached the model.
      const coverage =
        answer.engine === 'synthesizer'
          ? citationList.map((c) => ({ delivered: /** @type {const} */ ('full'), text: c.text }))
          : contextCoverage(citationList, answer.deliveredContext ?? context);
      const report = applyGrounding(messageEl, {
        scope: citations,
        sources: citationList.map((c, i) => ({ label: c.label, doc: c.doc, heading: c.heading, text: coverage[i].text, delivered: coverage[i].delivered })),
        // What the user said may be repeated without a source; the model's own earlier answers may not.
        given: [prompt, ...history.slice(-4).filter((h) => h.role === 'user').map((h) => h.content)],
        citedOnly: answer.engine === 'synthesizer',
      });
      const docs = new Map(listWorkspace().map((d) => [d.docId, d]));
      const receipt = storeReceiptDraft({
        createdAt: new Date().toISOString(),
        version: APP_VERSION,
        answer: { text: answerText, engine: answer.engine, locale: getLocale() },
        question: prompt,
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
            document: doc && {
              name: doc.name,
              kind: doc.kind,
              bytes: doc.bytes,
              fileSha256: doc.fileSha256,
              textSha256: doc.textSha256,
              textChars: doc.chars,
              pages: doc.pages,
              extractor: doc.extractor,
              chunker: doc.chunker,
            },
            chunk: c.span ? { index: c.span.chunkIndex, start: c.span.start, end: c.span.end } : undefined,
          };
        }),
      });
      messageEl.querySelector('.message-provenance')?.append(receiptButton(receipt));
      refreshIcons(messageEl);
    }
    pushTurns(x, answer, answerText, localOnly || usesWorkspace || namesWorkspace || Boolean(file), 'grounded');
  }

  // Answers quoting the on-device workspace stay on this device, even when chats are synced.
  void persistMessage(sid, { role: 'assistant', content: answerText, sources, metadata: answerMetadata(answer, 'grounded', trace, durationMs) }, { localOnly: localOnly || usesWorkspace || namesWorkspace });
}

/**
 * The attached file as free-chat context: all of it when it fits, otherwise its beginning and the
 * passages that match the question.
 * @param {{ docId: string, name: string }} file
 * @param {string} query
 * @returns {Promise<{ name: string, text: string } | null>}
 */
async function attachmentForChat(file, query) {
  try {
    const { text } = await getDocumentText(file.docId);
    if (text.length <= LIMITS.freeAttachmentChars) return { name: file.name, text };
    const ranges = [...(await firstChunks(file.docId, 2)), ...(await searchWorkspace(query, 12)).filter((h) => h.docId === file.docId)];
    return { name: file.name, text: excerptForChat(text, ranges, LIMITS.freeAttachmentChars) };
  } catch (err) {
    console.warn('[starpi] the attached file could not be read for the chat', err);
    return null;
  }
}

/**
 * Free chat: the conversation (and an attached file) goes to the model of the current mode, without
 * retrieval, source check or receipt. Every answer is marked as not checked against sources.
 * @param {Exchange} x
 */
async function answerFree(x) {
  const { prompt, file, sid, history, mode, localOnly, signal, started, removeLoading } = x;
  // Nothing is retrieved; an attached file keeps the question on this device (storeQuestion's rule).
  x.storeQuestion(false);
  const attachment = file ? await attachmentForChat(file, prompt) : null;
  /** @type {AnswerRequest} */
  const req = { plan: { kind: 'free', attachment }, prompt, history, signal, started, removeLoading, citations: null, query: prompt, method: '', hits: [] };
  const answer = await generateAnswer(mode, req);
  if (signal.aborted && !answer?.rendered) throw new DOMException('Aborted', 'AbortError');
  if (!answer?.text) {
    removeLoading();
    // The free chat has no sources to quote instead: it says why there is no answer.
    if (answer?.note && answer.notConfigured) appendNotice({ icon: 'info', tone: 'info', title: 'chat.free_no_model_title', body: 'chat.free_not_configured_body', params: { reason: answer.note } });
    else if (answer?.note) appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'chat.provider_failed_title', body: 'chat.free_failed_body', params: { reason: answer.note } });
    else appendNotice({ icon: 'info', tone: 'info', title: 'chat.free_no_model_title', body: 'chat.free_no_model_body' });
    return;
  }

  const durationMs = Math.round(performance.now() - started);
  const answerText = splitReasoning(answer.text).answer || answer.text;
  const label = engineLabel(answer.engine, answer.model);
  const trace = traceFor(req, t(label.badge, label.badgeParams), durationMs, answer.traceNote);
  // An answer about an attached file stays on this device like the file.
  const turnLocal = localOnly || Boolean(file);
  if (sid === currentSessionId()) {
    let messageEl = answer.element ?? null;
    if (!answer.rendered) {
      removeLoading();
      messageEl = appendMessage('assistant', answer.text, { ...label, trace, durationMs, traceRoles: FREE_TRACE_ROLES });
    }
    if (messageEl) markFreeAnswer(messageEl);
    pushTurns(x, answer, answerText, turnLocal, 'free');
  }
  void persistMessage(sid, { role: 'assistant', content: answerText, sources: [], metadata: answerMetadata(answer, 'free', trace, durationMs) }, { localOnly: turnLocal });
}

function removeAttachment() {
  attachment = null;
  attachSeq += 1;
  setHidden(byId('attachedInfo'), true);
  const input = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (input) input.value = '';
}

/** @param {File} file */
function attachFile(file) {
  const token = ++attachSeq;
  attachment = null;
  const done = readAttachment(file, token);
  attaching = done;
  void done.finally(() => {
    if (attaching === done) attaching = null;
  });
  return done;
}

/**
 * @param {File} file
 * @param {number} token  the attachment this read belongs to; a removed or replaced one is ignored
 */
async function readAttachment(file, token) {
  const info = byId('attachedInfo');
  const nameEl = byId('attachedFileName');
  setHidden(info, false);
  setText(nameEl, 'chat.attaching', { name: file.name });
  try {
    const doc = await addToWorkspace(file);
    if (token !== attachSeq) return;
    attachment = { docId: doc.docId, name: doc.name };
    setText(nameEl, 'chat.attached', { name: doc.name, chunks: doc.chunks });
  } catch (err) {
    if (token !== attachSeq) return;
    removeAttachment();
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
    appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'workspace.error_title', body: `workspace.error_${hasKey(`workspace.error_${code}`) ? code : 'internal'}`, params: { name: file.name } });
  }
}

/** Counts history loads, so only the newest one fills the chat (conversations opened in a row). */
let restoreSeq = 0;

export async function restoreHistory() {
  const seq = ++restoreSeq;
  const messages = await loadCurrentSession();
  if (seq !== restoreSeq) return;
  // Notices or answers shown while the history was loading (e.g. "on-device mode not available")
  // stay visible after the restored messages.
  const container = byId('chatMessages');
  const shownSinceBoot = container ? [...container.children].slice(1) : [];
  const live = conversation;
  conversation = [];
  resetMessages();
  for (const m of messages) {
    const meta = m.metadata ?? {};
    const engineId = typeof meta.engine === 'string' ? meta.engine : undefined;
    const model = typeof meta.model === 'string' ? meta.model : undefined;
    const chatMode = meta.chat_mode === 'free' || meta.chat_mode === 'grounded' ? meta.chat_mode : undefined;
    const el = appendMessage(m.role, m.content, { sources: m.sources, ...engineLabel(engineId, model) });
    if (chatMode === 'free' && m.role === 'assistant') markFreeAnswer(el);
    conversation.push({ role: m.role, content: m.content, localOnly: meta.local_only === true, shown: m.content, createdAt: m.created_at, engine: engineId, model, chatMode });
  }
  container?.append(...shownSinceBoot);
  conversation.push(...live);
}

/**
 * Shows a stored conversation (chosen in the conversation list).
 * @param {string} id
 */
export async function openConversation(id) {
  switchSession(id);
  resetConversation();
  await restoreHistory();
}

/**
 * Grows the message box with its text, up to its max-height (then it scrolls).
 * @param {HTMLTextAreaElement} input
 */
function autosize(input) {
  input.style.height = 'auto';
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}

/** Shows the chat mode in the composer: the pressed toggle button, the hint and the placeholder. */
function renderChatMode() {
  const free = getChatMode() === 'free';
  for (const btn of document.querySelectorAll('[data-action="set-chat-mode"]')) {
    btn.setAttribute('aria-pressed', String((btn.getAttribute('data-arg') === 'free') === free));
  }
  setText(byId('chatModeHint'), free ? 'chat.mode_free_hint' : 'chat.mode_grounded_hint');
  const input = byId('chatInput');
  const placeholder = free ? 'chat.placeholder_free' : 'chat.placeholder';
  input?.setAttribute('data-i18n-placeholder', placeholder);
  input?.setAttribute('placeholder', t(placeholder));
}

/**
 * Downloads the conversation as Markdown (the turns on screen) or as JSON (schema starpi.chat/v2,
 * the stored message tree). The formats load on first use.
 * @param {'md' | 'json'} format
 */
async function exportChat(format) {
  if (!conversation.length) {
    appendNotice({ icon: 'info', tone: 'info', title: 'chat.export_empty' });
    return;
  }
  const sessionId = currentSessionId();
  const exportedAt = new Date().toISOString();
  const turns = conversation.map((c) => ({
    role: c.role,
    content: c.shown ?? c.content,
    createdAt: c.createdAt ?? null,
    engine: c.engine ?? null,
    model: c.model ?? null,
    chatMode: c.chatMode ?? null,
  }));
  const { chatToMarkdown, exportFileName, exportSessionJson } = await import('./chat-export.js');
  const text =
    format === 'json'
      ? await exportSessionJson(sessionId, { exportedAt, version: APP_VERSION, locale: getLocale() }, turns)
      : chatToMarkdown(turns, {
          title: t('chat.export_title'),
          subtitle: t('chat.export_meta', { date: formatDate(new Date(exportedAt), { dateStyle: 'long', timeStyle: 'short' }), n: turns.length }),
          user: t('chat.export_you'),
          assistant: (turn) => {
            const label = engineLabel(turn.engine ?? undefined, turn.model ?? undefined);
            return label.badge ? `Starpi · ${t(label.badge, label.badgeParams)}` : 'Starpi';
          },
        });
  downloadText(exportFileName(sessionId, exportedAt, format), text, format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8');
}

/** Deletes the current chat on this device and, when chats are synced, its synced messages. */
async function deleteCurrentChat() {
  // An answer still being written would store its turn again after the delete.
  if (busy) {
    window.alert(t('chat.delete_busy'));
    return;
  }
  if (!window.confirm(t('chat.delete_confirm'))) return;
  const ok = await deleteSession(currentSessionId());
  resetConversation();
  appendNotice(ok ? { icon: 'check-circle-2', tone: 'success', title: 'chat.deleted_title' } : { icon: 'triangle-alert', tone: 'warn', title: 'chat.delete_partial_title' });
}

/** The chat menu closes like a menu: on a click elsewhere, and on Escape (focus returns to it). */
/**
 * Closes the chat menu and hands the focus back to its button, so a keyboard user stays where they were.
 * @param {HTMLElement} item a menu entry
 */
function closeChatMenu(item) {
  const menu = item.closest('details');
  if (!menu) return;
  menu.removeAttribute('open');
  menu.querySelector('summary')?.focus();
}

function initChatMenu() {
  const menu = /** @type {HTMLDetailsElement | null} */ (document.querySelector('details.chat-menu'));
  if (!menu) return;
  document.addEventListener('click', (e) => {
    if (menu.open && !(e.target instanceof Node && menu.contains(e.target))) menu.open = false;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

export function initChat() {
  const form = byId('chatForm');
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  // Voice input and quick edits fire 'input' too.
  input?.addEventListener('input', () => autosize(input));
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input) void submitChat(input.value);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submitChat(input.value);
    }
  });

  onAction('new-chat', () => {
    startNewSession();
    resetConversation();
    void refreshSyncStatus();
  });

  onAction('stop-generation', () => {
    activeAbort?.abort();
    engine.interrupt();
  });

  onAction('remove-attachment', () => removeAttachment());
  onAction('pick-chat-file', () => byId('chatFileInput')?.click());

  // Quick prompts carry an i18n key, so the question is asked in the active language. They ask about
  // the sources, so they always run in source mode; questions about the sample files
  // (data-scope="workspace") search only the workspace.
  onAction('quick-prompt', (el) => {
    const key = el.dataset.arg ?? '';
    if (key) void submitChat(hasKey(key) ? t(key) : key, { workspaceOnly: el.dataset.scope === 'workspace', chatMode: 'grounded' });
  });

  onAction('set-chat-mode', (el) => setChatMode(el.dataset.arg));
  onChatModeChange(() => renderChatMode());
  renderChatMode();

  onAction('export-chat', (el) => {
    closeChatMenu(el);
    return exportChat(el.dataset.arg === 'json' ? 'json' : 'md');
  });
  onAction('delete-chat', (el) => {
    closeChatMenu(el);
    return deleteCurrentChat();
  });
  initChatMenu();

  onChange('attach-file', (el) => {
    const fileInput = /** @type {HTMLInputElement} */ (el);
    const file = fileInput.files?.[0];
    fileInput.value = '';
    return file ? attachFile(file) : undefined;
  });
}
