// @ts-check
// Chat flow: retrieval (on-device workspace BM25 + knowledge base) -> answer (cloud provider /
// on-device model / own server / extractive synthesizer) -> render with verifiable citations -> persist.
import { currentSessionId, loadCurrentSession, persistMessage, refreshSyncStatus, startNewSession } from './chat-store.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { startLocalEngine } from './engine-ui.js';
import { getLocale, hasKey, setText, t } from './i18n/index.js';
import { appendLoading, appendMessage, appendNotice, createStreamingMessage, resetMessages, splitReasoning } from './messages.js';
import { buildInstructions, buildSystemPrompt, contextSection } from './prompts.js';
import { callGemini, callLocalServer, callOpenRouter, hasGeminiKey, hasOpenRouterKey } from './providers.js';
import { registerCitations } from './rag/citations.js';
import { addToWorkspace, firstChunks, searchWorkspace } from './rag/workspace.js';
import { sanitizeModelNames } from './render.js';
import { assignCitations, buildContext, distinctSources, rankHitsLocally } from './retrieval.js';
import { isUserAbort } from './signals.js';
import { getLlmUrl, getMode } from './state.js';
import { listDocuments, recentKnowledge, searchKnowledge } from './supabase.js';
import { describeTrace, isGreeting, synthesizeAnswer } from './synthesizer.js';
import { setAssistantStatus } from './ui.js';
import * as engine from './webgpu/engine.js';
import { budgetPrompt } from './webgpu/models.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./rag/workspace.js').WorkspaceHit} WorkspaceHit */
/** @typedef {{ role: 'user' | 'assistant', content: string }} Turn */

/** i18n keys of the engine that produced an answer (stored with the message as `engine`). */
const ENGINE_LABELS = /** @type {Record<string, string>} */ ({
  cloud: 'engine.label_cloud',
  client: 'engine.label_client',
  local: 'engine.label_server',
  synthesizer: 'engine.label_synthesizer',
});

/** @type {Turn[]} */
let conversation = [];
let busy = false;
/** @type {AbortController | null} */
let activeAbort = null;
/** @type {{ docId: string, name: string } | null} */
let attachment = null;
/** @type {{ at: number, titles: string[] } | null} */
let titlesCache = null;

export function invalidateKnownTitles() {
  titlesCache = null;
}

export function isChatBusy() {
  return busy;
}

async function knownTitles() {
  if (titlesCache && Date.now() - titlesCache.at < 60_000) return titlesCache.titles;
  const res = await listDocuments();
  const titles = res.ok ? res.data.map((d) => d.title) : [];
  titlesCache = { at: Date.now(), titles };
  return titles;
}

/**
 * @param {WorkspaceHit} h
 * @returns {KnowledgeHit}
 */
function workspaceHit(h) {
  return {
    documentId: h.docId,
    documentTitle: h.docName,
    heading: '',
    content: h.text,
    tags: [],
    rank: h.score,
    workspace: { docId: h.docId, chunkIndex: h.chunkIndex, start: h.start, end: h.end },
  };
}

/**
 * Workspace chunks for the question; a just-attached file always contributes (its best chunks, or
 * its first chunks when nothing in it matches, e.g. "summarize this file").
 * @param {string} query
 * @param {string | null} focusDocId
 * @returns {Promise<KnowledgeHit[]>}
 */
async function retrieveWorkspace(query, focusDocId) {
  try {
    let hits = await searchWorkspace(query, LIMITS.retrievalRows);
    if (focusDocId && !hits.some((h) => h.docId === focusDocId)) hits = [...(await firstChunks(focusDocId, 3)), ...hits];
    return hits.map(workspaceHit);
  } catch (err) {
    console.warn('[starpi] workspace search failed', err);
    return [];
  }
}

/**
 * @param {string} query
 * @param {import('./config.js').ComputeMode} mode
 * @param {string | null} focusDocId
 * @returns {Promise<{ hits: KnowledgeHit[], method: string }>}
 */
async function retrieve(query, mode, focusDocId) {
  const local = await retrieveWorkspace(query, focusDocId);
  const localPart = local.length ? t('retrieval.workspace', { n: local.length }) : '';
  const join = (/** @type {string} */ remote) => [localPart, remote].filter(Boolean).join(' + ');
  const limit = LIMITS.retrievalRows + (focusDocId ? 3 : 0);

  if (mode !== 'client') {
    const search = await searchKnowledge(query);
    if (search.ok && search.data.length > 0) {
      return { hits: [...local, ...search.data].slice(0, limit), method: join(t('retrieval.fts')) };
    }
    const recent = await recentKnowledge(30);
    const why = search.ok ? 'retrieval.why_no_match' : search.error.kind === 'missing_function' ? 'retrieval.why_missing' : 'retrieval.why_unavailable';
    if (!recent.ok) {
      return { hits: local, method: join(t('retrieval.unreachable', { kind: recent.error.kind })) };
    }
    const ranked = rankHitsLocally(query, recent.data, LIMITS.retrievalRows);
    return { hits: [...local, ...ranked].slice(0, limit), method: join(t('retrieval.keyword', { why: t(why) })) };
  }

  // Local mode: candidates are fetched without the question and ranked in the browser.
  const recent = await recentKnowledge(30);
  const ranked = recent.ok ? rankHitsLocally(query, recent.data, LIMITS.retrievalRows) : [];
  return { hits: [...local, ...ranked].slice(0, limit), method: join(t('retrieval.local')) };
}

/**
 * @typedef {object} Answer
 * @property {string} text
 * @property {'cloud' | 'client' | 'local' | 'synthesizer'} engine
 * @property {boolean} [rendered] already rendered by a streaming bubble
 * @property {string} [note]
 */

/**
 * @param {{ prompt: string, context: string, history: Turn[], signal: AbortSignal }} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithCloud(req) {
  const system = buildSystemPrompt({ locale: getLocale(), target: 'cloud', context: req.context });
  if (hasGeminiKey()) {
    try {
      const r = await callGemini(`${system}\n\n${t('prompt.user_question')}\n${req.prompt}`, { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      console.warn('[starpi] Gemini failed, trying the next provider:', err instanceof Error ? err.message : err);
    }
  }
  if (hasOpenRouterKey()) {
    try {
      const r = await callOpenRouter([{ role: 'system', content: system }, ...req.history.slice(-4), { role: 'user', content: req.prompt }], {
        signal: req.signal,
      });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      const reason = sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160);
      return { text: '', engine: 'synthesizer', note: t('chat.note_cloud_failed', { reason }) };
    }
  }
  return null;
}

/**
 * @param {{ prompt: string, context: string, history: Turn[], signal: AbortSignal, citations: string | null, query: string, method: string, hits: KnowledgeHit[], started: number, removeLoading: () => void }} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithLocalModel(req) {
  const ready = engine.isReady() || (await startLocalEngine({ interactive: true }));
  const model = engine.getEngineState().model;
  if (!ready || !model || req.signal.aborted) return null;

  const locale = getLocale();
  const budget = budgetPrompt({
    contextWindow: model.chatOptions.context_window_size,
    maxOutputTokens: 512,
    system: buildInstructions(locale, 'local'),
    context: req.context,
    history: req.history.slice(-4),
    user: req.prompt,
  });

  req.removeLoading();
  const stream = createStreamingMessage(ENGINE_LABELS.client);
  const onAbort = () => engine.interrupt();
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const text = await engine.generate({
      messages: [
        { role: 'system', content: `${budget.system}\n\n${contextSection(locale, budget.context)}` },
        ...budget.history,
        { role: 'user', content: budget.user },
      ],
      maxTokens: 512,
      temperature: 0.2,
      onDelta: (delta) => stream.update(delta),
    });
    if (!text.trim()) {
      stream.remove();
      return null;
    }
    const durationMs = Math.round(performance.now() - req.started);
    const trace = describeTrace({ query: req.query, method: req.method, hits: req.hits, engineLabel: t(ENGINE_LABELS.client), durationMs });
    stream.finalize(text, { citations: req.citations, trace, durationMs });
    return { text, engine: 'client', rendered: true };
  } catch (err) {
    stream.remove();
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', engine: 'synthesizer', note: t('chat.note_local_failed', { reason: message }) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {{ prompt: string, context: string, history: Turn[], signal: AbortSignal }} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithOwnServer(req) {
  try {
    const r = await callLocalServer(
      getLlmUrl(),
      [
        { role: 'system', content: buildSystemPrompt({ locale: getLocale(), target: 'server', context: req.context }) },
        ...req.history.slice(-4),
        { role: 'user', content: req.prompt },
      ],
      { signal: req.signal },
    );
    return { text: r.text, engine: 'local' };
  } catch (err) {
    if (req.signal.aborted) throw err;
    return { text: '', engine: 'synthesizer', note: t('chat.note_server_failed', { reason: err instanceof Error ? err.message : String(err) }) };
  }
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  setHidden(byId('stopBtn'), !on);
  const send = /** @type {HTMLButtonElement | null} */ (byId('sendBtn'));
  if (send) send.disabled = on;
  setAssistantStatus(on ? 'status.generating' : 'status.ready');
}

/** @param {string} rawText */
export async function submitChat(rawText) {
  if (busy) {
    setAssistantStatus('status.busy');
    return;
  }
  const userText = rawText.trim().slice(0, LIMITS.chatInputChars);
  const file = attachment;
  if (!userText && !file) return;

  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  removeAttachment();

  const sid = currentSessionId();
  const history = conversation.slice();
  const mode = getMode();
  const localOnly = mode === 'client';
  const prompt = userText || t('chat.summarize_file', { name: file?.name ?? '' });
  const shownText = file ? `${prompt}\n\n[${file.name}]` : prompt;

  appendMessage('user', shownText);
  // A question about an attached workspace file names that file: keep it on the device like its answer.
  void persistMessage(sid, { role: 'user', content: shownText, sources: [], metadata: {} }, { localOnly: localOnly || Boolean(file) });

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  const removeLoading = appendLoading();
  const started = performance.now();

  try {
    const { hits, method } = await retrieve(prompt, mode, file?.docId ?? null);
    const greeting = !file && isGreeting(userText);
    const used = greeting ? [] : hits;
    const citationList = assignCitations(used, { excerptChars: LIMITS.excerptChars });
    const citations = registerCitations(citationList);
    const sources = distinctSources(used);
    const context = buildContext(citationList, { maxChars: LIMITS.contextCharsCloud });

    /** @type {Answer | null} */
    let answer = null;
    const common = { prompt, context, history, signal: controller.signal };
    if (mode === 'council') answer = await answerWithCloud(common);
    else if (mode === 'client') answer = await answerWithLocalModel({ ...common, citations, query: prompt, method, hits: used, started, removeLoading });
    else answer = await answerWithOwnServer(common);

    const note = answer?.note;
    if (!answer || !answer.text) {
      const modelAvailable = mode !== 'council' || hasGeminiKey() || hasOpenRouterKey();
      answer = {
        text: synthesizeAnswer({ query: prompt, hits: used, citations: citationList, knownTitles: await knownTitles(), modelAvailable }),
        engine: 'synthesizer',
      };
    }
    if (controller.signal.aborted && !answer.rendered) throw new DOMException('Aborted', 'AbortError');

    const durationMs = Math.round(performance.now() - started);
    const answerText = splitReasoning(answer.text).answer || answer.text;
    const trace = describeTrace({ query: prompt, method, hits: used, engineLabel: t(ENGINE_LABELS[answer.engine]), durationMs, note });
    const metadata = { engine: answer.engine, thoughts: trace, duration_ms: durationMs };

    if (sid === currentSessionId()) {
      if (!answer.rendered) {
        removeLoading();
        appendMessage('assistant', answer.text, { citations, badge: ENGINE_LABELS[answer.engine], trace, durationMs });
      }
      conversation.push({ role: 'user', content: prompt.slice(0, 4_000) }, { role: 'assistant', content: answerText });
    }

    // Answers quoting the on-device workspace stay on this device, even when chats are synced.
    const usesWorkspace = used.some((h) => h.workspace);
    void persistMessage(sid, { role: 'assistant', content: answerText, sources, metadata }, { localOnly: localOnly || usesWorkspace });
  } catch (err) {
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

function removeAttachment() {
  attachment = null;
  setHidden(byId('attachedInfo'), true);
  const input = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (input) input.value = '';
}

/** @param {File} file */
async function attachFile(file) {
  const info = byId('attachedInfo');
  const nameEl = byId('attachedFileName');
  setHidden(info, false);
  setText(nameEl, 'chat.attaching', { name: file.name });
  try {
    const doc = await addToWorkspace(file);
    attachment = { docId: doc.docId, name: doc.name };
    setText(nameEl, 'chat.attached', { name: doc.name, chunks: doc.chunks });
  } catch (err) {
    removeAttachment();
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'internal';
    appendNotice({ icon: 'triangle-alert', tone: 'warn', title: 'workspace.error_title', body: `workspace.error_${hasKey(`workspace.error_${code}`) ? code : 'internal'}`, params: { name: file.name } });
  }
}

export async function restoreHistory() {
  const messages = await loadCurrentSession();
  // Notices or answers shown while the history was loading (e.g. "on-device mode not available")
  // stay visible after the restored messages.
  const container = byId('chatMessages');
  const shownSinceBoot = container ? [...container.children].slice(1) : [];
  const live = conversation;
  conversation = [];
  resetMessages();
  for (const m of messages) {
    const engineKey = typeof m.metadata?.engine === 'string' ? ENGINE_LABELS[m.metadata.engine] : undefined;
    appendMessage(m.role, m.content, { sources: m.sources, badge: engineKey });
    conversation.push({ role: m.role, content: m.content });
  }
  container?.append(...shownSinceBoot);
  conversation.push(...live);
}

export function initChat() {
  const form = byId('chatForm');
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
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
    conversation = [];
    resetMessages();
    setAssistantStatus('status.ready');
    void refreshSyncStatus();
  });

  onAction('stop-generation', () => {
    activeAbort?.abort();
    engine.interrupt();
  });

  onAction('remove-attachment', () => removeAttachment());

  // Quick prompts carry an i18n key, so the question is asked in the active language.
  onAction('quick-prompt', (el) => {
    const key = el.dataset.arg ?? '';
    if (key) void submitChat(hasKey(key) ? t(key) : key);
  });

  onChange('attach-file', (el) => {
    const fileInput = /** @type {HTMLInputElement} */ (el);
    const file = fileInput.files?.[0];
    fileInput.value = '';
    return file ? attachFile(file) : undefined;
  });
}
