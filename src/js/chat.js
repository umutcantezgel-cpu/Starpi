// @ts-check
// Chat flow: retrieval -> answer (cloud provider / on-device model / own server / extractive
// synthesizer) -> render -> persist. One request at a time; the Stop button aborts network calls
// and interrupts on-device generation.
import { LIMITS } from './config.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { startLocalEngine } from './engine-ui.js';
import { currentSessionId, loadCurrentSession, persistMessage, refreshSyncStatus, startNewSession } from './chat-store.js';
import { appendLoading, appendMessage, createStreamingMessage, resetMessages, splitReasoning } from './messages.js';
import { callGemini, callLocalServer, callOpenRouter, hasGeminiKey, hasOpenRouterKey } from './providers.js';
import { escapeMarkdown, sanitizeModelNames } from './render.js';
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
  cloud: '✨ Starpi Assistent · Cloud Verbindung',
  client: '🔒 Lokaler Modus · im Browser berechnet',
  local: '🖥️ Eigener Server (MLX/Ollama)',
  synthesizer: '📚 Direkt aus der Wissensdatenbank',
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
  const titles = res.ok ? res.data.map((d) => d.title).filter(Boolean) : [];
  titlesCache = { at: Date.now(), titles };
  return titles;
}

/**
 * @param {string} query
 * @param {import('./config.js').ComputeMode} mode
 * @returns {Promise<{ hits: KnowledgeHit[], method: string }>}
 */
async function retrieve(query, mode) {
  if (mode !== 'client') {
    const search = await searchKnowledge(query);
    if (search.ok && search.data.length > 0) {
      return { hits: search.data, method: 'Postgres Volltextsuche (search_knowledge)' };
    }
    const recent = await recentKnowledge(30);
    const why = search.ok
      ? 'keine Volltext Treffer'
      : search.error.kind === 'missing_function'
        ? 'Suchfunktion noch nicht installiert'
        : 'Volltextsuche nicht erreichbar';
    if (!recent.ok) return { hits: [], method: `Wissensdatenbank nicht erreichbar (${recent.error.kind})` };
    return { hits: rankHitsLocally(query, recent.data, LIMITS.retrievalRows), method: `Stichwortsuche über die neuesten Dokumente (${why})` };
  }
  // Local mode: fetch candidates without sending the question anywhere, rank in the browser.
  const recent = await recentKnowledge(30);
  if (!recent.ok) return { hits: [], method: `Wissensdatenbank nicht erreichbar (${recent.error.kind})` };
  return {
    hits: rankHitsLocally(query, recent.data, LIMITS.retrievalRows),
    method: 'Stichwortsuche im Browser (die Frage verlässt das Gerät nicht)',
  };
}

const SYSTEM_PROMPT = `Du bist Starpi, ein intelligenter und hilfsbereiter Unternehmensassistent.
Antworte stets freundlich, professionell und direkt auf Deutsch ohne Ausschmückung oder unnötigen Jargon.

WICHTIGE ANWEISUNGEN:
1. Nutze die Auszüge aus der Wissensdatenbank als Faktenbasis und erfinde keine Fakten.
2. Wenn nach Personen, Aufgaben, Terminen oder Budgets gefragt wird, nenne die exakten Fakten und Zahlen übersichtlich.
3. Nenne zu keinem Zeitpunkt Namen von KI Modellen oder Providern.
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
  const context = req.context || 'Keine passenden Auszüge gefunden.';
  if (hasGeminiKey()) {
    try {
      const r = await callGemini(`${SYSTEM_PROMPT}\n\nWissensdatenbank:\n${context}\n\nNutzeranfrage: ${req.prompt}`, { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      console.warn('[starpi] Gemini failed, trying the next provider:', err instanceof Error ? err.message : err);
    }
  }
  if (hasOpenRouterKey()) {
    try {
      const r = await callOpenRouter(
        [{ role: 'system', content: `${SYSTEM_PROMPT}\n\nWissensdatenbank:\n${context}` }, ...req.history.slice(-4), { role: 'user', content: req.prompt }],
        { signal: req.signal },
      );
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      return {
        text: '',
        engine: 'synthesizer',
        note: `Cloud Anbieter nicht erreichbar (${sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160)})`,
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
    system: `Du bist Starpi, ein verlässlicher Assistent für Unternehmensdaten. Antworte auf Deutsch und erfinde keine Fakten. ${CONTEXT_RULES}`,
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
        { role: 'system', content: budget.context ? `${budget.system}\n\nWissensdatenbank:\n${budget.context}` : budget.system },
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
    const trace = describeTrace({ query: req.query, method: req.method, hits: req.hits, engineLabel: 'Lokales Modell im Browser (WebGPU)', durationMs });
    stream.finalize(text, req.sources, trace, durationMs);
    return { text, engine: 'client', rendered: true };
  } catch (err) {
    stream.remove();
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', engine: 'synthesizer', note: `Lokales Modell: ${message}` };
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
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nWissensdatenbank:\n${req.context || 'Keine passenden Auszüge gefunden.'}` },
        ...req.history.slice(-4),
        { role: 'user', content: req.prompt },
      ],
      { signal: req.signal },
    );
    return { text: r.text, engine: 'local' };
  } catch (err) {
    if (req.signal.aborted) throw err;
    return { text: '', engine: 'synthesizer', note: `Eigener Server nicht erreichbar (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  setHidden(byId('stopBtn'), !on);
  const send = /** @type {HTMLButtonElement | null} */ (byId('sendBtn'));
  if (send) send.disabled = on;
  setAssistantStatus(on ? 'Antwort wird erstellt…' : 'Bereit für Ihre Fragen');
}

/** @param {string} rawText */
export async function submitChat(rawText) {
  if (busy) {
    setAssistantStatus('Bitte warten, die vorherige Antwort läuft noch.');
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
  const shownText = userText || `📎 ${file?.name ?? 'Datei'}`;
  const prompt = file ? `${userText}\n\n[Angehängte Datei: ${file.name}]\n${file.content}` : userText;
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
      engineLabel: ENGINE_LABELS[answer.engine].replace(/^\S+\s/, ''),
      durationMs,
      note,
    });
    const metadata = { engine: answer.engine, thoughts: trace, duration_ms: durationMs };

    // The user may have started a new chat meanwhile: persist to the original session only.
    if (sid === currentSessionId()) {
      if (!answer.rendered) {
        removeLoading();
        appendMessage('assistant', answer.text, { sources, badge: ENGINE_LABELS[answer.engine], trace, durationMs });
      }
      conversation.push({ role: 'user', content: prompt.slice(0, 4_000) }, { role: 'assistant', content: answerText });
    }
    void persistMessage(sid, { role: 'assistant', content: answer.text, sources, metadata }, { localOnly });
  } catch (err) {
    removeLoading();
    if (isUserAbort(err) || controller.signal.aborted) {
      if (sid === currentSessionId()) appendMessage('assistant', '⏹️ Antwort gestoppt.');
    } else {
      console.error('[starpi] chat request failed', err);
      appendMessage('assistant', `Fehler beim Verarbeiten: ${escapeMarkdown(sanitizeModelNames(err instanceof Error ? err.message : String(err)))}`);
    }
  } finally {
    removeLoading();
    if (activeAbort === controller) activeAbort = null;
    setBusy(false);
  }
}

function stopGeneration() {
  activeAbort?.abort();
  engine.interrupt();
}

export function startNewChat() {
  stopGeneration();
  startNewSession();
  conversation = [];
  resetMessages();
}

/** Replays the stored history of the current session. */
export async function restoreHistory() {
  const sid = currentSessionId();
  const rows = await loadCurrentSession();
  if (sid !== currentSessionId() || rows.length === 0) return;
  resetMessages();
  conversation = [];
  for (const row of rows) {
    const meta = /** @type {{ engine?: string, thoughts?: string | null, duration_ms?: number | null }} */ (row.metadata ?? {});
    const role = row.role === 'user' ? 'user' : 'assistant';
    conversation.push({ role, content: role === 'assistant' ? splitReasoning(row.content).answer : row.content });
    appendMessage(role, row.content, {
      sources: Array.isArray(row.sources) ? row.sources.filter((s) => s && typeof s.title === 'string') : [],
      badge: role === 'assistant' ? (ENGINE_LABELS[meta.engine ?? ''] ?? '✨ Starpi Assistent · Gespeichert') : '',
      trace: typeof meta.thoughts === 'string' ? meta.thoughts : null,
      durationMs: typeof meta.duration_ms === 'number' ? meta.duration_ms : null,
    });
  }
  void refreshSyncStatus();
}

function removeAttachment() {
  attachment = null;
  const fileInput = /** @type {HTMLInputElement | null} */ (byId('chatFileInput'));
  if (fileInput) fileInput.value = '';
  setHidden(byId('attachedInfo'), true);
}

/** @param {HTMLElement} el */
async function attachFile(el) {
  const inputEl = /** @type {HTMLInputElement} */ (el);
  const file = inputEl.files?.[0];
  if (!file) return;
  if (file.size > LIMITS.attachmentBytes) {
    window.alert(`Die Datei ist zu groß (maximal ${Math.round(LIMITS.attachmentBytes / 1024)} KB).`);
    inputEl.value = '';
    return;
  }
  try {
    attachment = { name: file.name, content: await file.text() };
  } catch {
    window.alert('Die Datei konnte nicht gelesen werden.');
    inputEl.value = '';
    return;
  }
  const nameEl = byId('attachedFileName');
  if (nameEl) nameEl.textContent = file.name;
  setHidden(byId('attachedInfo'), false);
}

/** @param {HTMLTextAreaElement} el */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}

export function initChat() {
  const form = byId('chatForm');
  const input = /** @type {HTMLTextAreaElement | null} */ (byId('chatInput'));
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitChat(input?.value ?? '');
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitChat(input.value);
    }
  });
  input?.addEventListener('input', () => autoResize(input));
  if (input) input.maxLength = LIMITS.chatInputChars;

  onAction('quick-prompt', (el) => submitChat(el.dataset.arg ?? ''));
  onAction('new-chat', () => startNewChat());
  onAction('stop-generation', () => stopGeneration());
  onAction('remove-attachment', () => removeAttachment());
  onChange('attach-file', (el) => attachFile(el));
}
