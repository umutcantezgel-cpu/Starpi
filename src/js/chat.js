// @ts-check
// Chat flow: retrieval (BM25 + Postgres) -> answer (cloud provider / on-device model / own server / extractive
// synthesizer) -> render -> persist.
import { currentSessionId, loadCurrentSession, persistMessage, refreshSyncStatus, startNewSession } from './chat-store.js';
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { startLocalEngine } from './engine-ui.js';
import { t } from './i18n/index.js';
import { appendLoading, appendMessage, createStreamingMessage, resetMessages, splitReasoning } from './messages.js';
import { callGemini, callLocalServer, callOpenRouter, hasGeminiKey, hasOpenRouterKey } from './providers.js';
import { searchLocalBM25 } from './rag/ingestion-service.js';
import { sanitizeModelNames } from './render.js';
import { buildContext, CONTEXT_RULES, distinctSources, rankHitsLocally } from './retrieval.js';
import { isUserAbort } from './signals.js';
import { getLlmUrl, getMode } from './state.js';
import { listDocuments, recentKnowledge, searchKnowledge } from './supabase.js';
import { describeTrace, isGreeting, synthesizeAnswer } from './synthesizer.js';
import { setAssistantStatus } from './ui.js';
import * as engine from './webgpu/engine.js';
import { budgetPrompt } from './webgpu/models.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {{ role: 'user' | 'assistant', content: string }} Turn */

const ENGINE_LABELS = /** @type {Record<string, string>} */ ({
  cloud: 'Starpi Cloud Assistant',
  client: 'Local In-Browser WebGPU',
  local: 'Custom Server (MLX/Ollama)',
  synthesizer: 'Knowledge Base Direct',
});

/** @type {Turn[]} */
let conversation = [];
let busy = false;
/** @type {AbortController | null} */
let activeAbort = null;
/** @type {{ name: string, content: string } | null} */
let attachment = null;
/** @type {{ at: number, titles: string[] } | null} */
let titlesCache = null;

export function invalidateKnownTitles() {
  titlesCache = null;
}

async function knownTitles() {
  if (titlesCache && Date.now() - titlesCache.at < 60_000) return titlesCache.titles;
  const res = await listDocuments();
  const titles = res.ok ? res.data.map((d) => d.title) : [];
  titlesCache = { at: Date.now(), titles };
  return titles;
}

/**
 * @param {string} query
 * @param {import('./config.js').ComputeMode} mode
 * @returns {Promise<{ hits: KnowledgeHit[], method: string }>}
 */
async function retrieve(query, mode) {
  // 1. Query client-side BM25 index (for documents parsed and indexed in-browser)
  /** @type {KnowledgeHit[]} */
  let bm25Hits = [];
  try {
    const scored = await searchLocalBM25(query, LIMITS.retrievalRows);
    bm25Hits = scored.map((s) => ({
      documentId: s.chunk.documentId,
      documentTitle: s.chunk.documentTitle,
      heading: `Chunk #${s.chunk.chunkIndex}`,
      content: s.chunk.content,
      rank: s.score,
    }));
  } catch (err) {
    console.warn('[starpi] BM25 local search error', err);
  }

  if (mode !== 'client') {
    const search = await searchKnowledge(query);
    if (search.ok && search.data.length > 0) {
      const merged = [...bm25Hits, ...search.data];
      return { hits: merged.slice(0, LIMITS.retrievalRows), method: 'Postgres & BM25 Search' };
    }
    const recent = await recentKnowledge(30);
    const why = search.ok
      ? 'no full-text matches'
      : search.error.kind === 'missing_function'
        ? 'search function not installed'
        : 'full-text search unavailable';
    if (!recent.ok) return { hits: bm25Hits, method: bm25Hits.length ? 'BM25 Client Index' : `Knowledge base unreachable (${recent.error.kind})` };
    const localRanked = rankHitsLocally(query, recent.data, LIMITS.retrievalRows);
    const merged = [...bm25Hits, ...localRanked];
    return { hits: merged.slice(0, LIMITS.retrievalRows), method: `Keyword & BM25 Search (${why})` };
  }

  // Local mode: client-side BM25 + candidates ranked in browser without sending question anywhere
  const recent = await recentKnowledge(30);
  const localRanked = recent.ok ? rankHitsLocally(query, recent.data, LIMITS.retrievalRows) : [];
  const merged = [...bm25Hits, ...localRanked];
  return {
    hits: merged.slice(0, LIMITS.retrievalRows),
    method: 'Local BM25 & Browser Search (zero data leaves device)',
  };
}

const SYSTEM_PROMPT = `You are Starpi, an enterprise AI knowledge assistant.
Answer professionally, factually, and concisely.

INSTRUCTIONS:
1. Use the provided excerpts from the knowledge base as facts and never fabricate facts.
2. When asked about responsibilities, dates, or budgets, provide exact numbers and facts.
3. Never mention internal model or provider names.
4. ${CONTEXT_RULES}`;

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
  const context = req.context || 'No relevant excerpts found.';
  if (hasGeminiKey()) {
    try {
      const r = await callGemini(`${SYSTEM_PROMPT}\n\nKnowledge Base:\n${context}\n\nUser Query: ${req.prompt}`, { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      console.warn('[starpi] Gemini failed, trying the next provider:', err instanceof Error ? err.message : err);
    }
  }
  if (hasOpenRouterKey()) {
    try {
      const r = await callOpenRouter(
        [{ role: 'system', content: `${SYSTEM_PROMPT}\n\nKnowledge Base:\n${context}` }, ...req.history.slice(-4), { role: 'user', content: req.prompt }],
        { signal: req.signal },
      );
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      return {
        text: '',
        engine: 'synthesizer',
        note: `Cloud provider unavailable (${sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160)})`,
      };
    }
  }
  return null;
}

/**
 * @param {{ prompt: string, context: string, history: Turn[], signal: AbortSignal, sources: Array<{ title: string, rank: number | null }>, query: string, method: string, hits: KnowledgeHit[], started: number, removeLoading: () => void }} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithLocalModel(req) {
  const ready = engine.isReady() || (await startLocalEngine({ interactive: true }));
  const model = engine.getEngineState().model;
  if (!ready || !model || req.signal.aborted) return null;

  const budget = budgetPrompt({
    contextWindow: model.chatOptions.context_window_size,
    maxOutputTokens: 512,
    system: `You are Starpi, a reliable enterprise assistant. Answer accurately based on context. Do not invent facts. ${CONTEXT_RULES}`,
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
        { role: 'system', content: budget.context ? `${budget.system}\n\nKnowledge Base:\n${budget.context}` : budget.system },
        ...budget.history,
        { role: 'user', content: budget.user },
      ],
      maxTokens: 512,
      temperature: 0.2,
      onDelta: (t) => stream.update(t),
    });
    if (!text.trim()) {
      stream.remove();
      return null;
    }
    const durationMs = Math.round(performance.now() - req.started);
    const trace = describeTrace({ query: req.query, method: req.method, hits: req.hits, engineLabel: 'Local WebGPU Browser Model', durationMs });
    stream.finalize(text, req.sources, trace, durationMs);
    return { text, engine: 'client', rendered: true };
  } catch (err) {
    stream.remove();
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', engine: 'synthesizer', note: `Local model: ${message}` };
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
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nKnowledge Base:\n${req.context || 'No matching excerpts found.'}` },
        ...req.history.slice(-4),
        { role: 'user', content: req.prompt },
      ],
      { signal: req.signal },
    );
    return { text: r.text, engine: 'local' };
  } catch (err) {
    if (req.signal.aborted) throw err;
    return { text: '', engine: 'synthesizer', note: `Custom server unavailable (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  setHidden(byId('stopBtn'), !on);
  const send = /** @type {HTMLButtonElement | null} */ (byId('sendBtn'));
  if (send) send.disabled = on;
  setAssistantStatus(on ? 'Generating response…' : t('status.ready'));
}

/** @param {string} rawText */
export async function submitChat(rawText) {
  if (busy) {
    setAssistantStatus('Please wait, previous response is still generating.');
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
  const shownText = userText || `[File: ${file?.name ?? 'Document'}]`;
  const prompt = file ? `${userText}\n\n[Attached File: ${file.name}]\n${file.content}` : userText;
  const query = userText || file?.name || '';

  appendMessage('user', shownText);
  void persistMessage(sid, { role: 'user', content: shownText, sources: [], metadata: {} }, { localOnly });

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  const removeLoading = appendLoading();
  const started = performance.now();

  try {
    const { hits, method } = await retrieve(query, mode);
    const greeting = isGreeting(userText);
    const sources = greeting ? [] : distinctSources(hits);
    const context = greeting ? '' : buildContext(hits, { maxChars: LIMITS.contextCharsCloud, excerptChars: LIMITS.excerptChars });

    /** @type {Answer | null} */
    let answer = null;
    const common = { prompt, context, history, signal: controller.signal };
    if (mode === 'council') answer = await answerWithCloud(common);
    else if (mode === 'client') answer = await answerWithLocalModel({ ...common, sources, query, method, hits, started, removeLoading });
    else answer = await answerWithOwnServer(common);

    const note = answer?.note;
    if (!answer || !answer.text) {
      const modelAvailable = mode !== 'council' || hasGeminiKey() || hasOpenRouterKey();
      answer = {
        text: synthesizeAnswer({ query: userText || query, hits, knownTitles: await knownTitles(), modelAvailable }),
        engine: 'synthesizer',
      };
    }
    if (controller.signal.aborted && !answer.rendered) throw new DOMException('Aborted', 'AbortError');

    const durationMs = Math.round(performance.now() - started);
    const answerText = splitReasoning(answer.text).answer || answer.text;
    const trace = describeTrace({
      query,
      method,
      hits,
      engineLabel: ENGINE_LABELS[answer.engine],
      durationMs,
      note,
    });
    const metadata = { engine: answer.engine, thoughts: trace, duration_ms: durationMs };

    if (sid === currentSessionId()) {
      if (!answer.rendered) {
        removeLoading();
        appendMessage('assistant', answer.text, { sources, badge: ENGINE_LABELS[answer.engine], trace, durationMs });
      }
      conversation.push({ role: 'user', content: prompt.slice(0, 4_000) }, { role: 'assistant', content: answerText });
    }

    void persistMessage(sid, { role: 'assistant', content: answerText, sources, metadata }, { localOnly });
  } catch (err) {
    removeLoading();
    if (!isUserAbort(err)) {
      appendMessage('assistant', `Error processing request: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    setBusy(false);
    activeAbort = null;
  }
}

function removeAttachment() {
  attachment = null;
  const info = byId('attachedInfo');
  if (info) setHidden(info, true);
  const input = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (input) input.value = '';
}

export async function restoreHistory() {
  const session = await loadCurrentSession();
  conversation = [];
  resetMessages();
  if (!session || !session.messages.length) return;
  for (const m of session.messages) {
    appendMessage(m.role, m.content, { sources: m.sources, badge: m.metadata?.engine ? ENGINE_LABELS[m.metadata.engine] : undefined });
    conversation.push({ role: m.role, content: m.content });
  }
}

export function initChat() {
  const form = byId('chatForm');
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input) void submitChat(input.value);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitChat(input.value);
    }
  });

  onAction('new-chat', () => {
    startNewSession();
    conversation = [];
    resetMessages();
    setAssistantStatus(t('status.ready'));
    void refreshSyncStatus();
  });

  onAction('stop-generation', () => {
    activeAbort?.abort();
    engine.interrupt();
  });

  onAction('remove-attachment', () => removeAttachment());

  onAction('quick-prompt', (el) => {
    const arg = el.dataset.arg ?? '';
    if (arg) void submitChat(arg);
  });

  onChange('attach-file', async (el) => {
    const fileInput = /** @type {HTMLInputElement} */ (el);
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > LIMITS.ingestFileBytes) {
      window.alert(t('ingest.file_too_large'));
      fileInput.value = '';
      return;
    }
    const text = await file.text().catch(() => '');
    attachment = { name: file.name, content: text.slice(0, LIMITS.attachmentChars) };
    const info = byId('attachedInfo');
    const nameEl = byId('attachedFileName');
    if (nameEl) nameEl.textContent = file.name;
    if (info) setHidden(info, false);
  });
}
