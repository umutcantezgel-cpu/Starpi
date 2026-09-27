// @ts-check
// Chat flow: retrieval (on-device workspace BM25 + knowledge base) -> answer (cloud provider /
// on-device model / own server / extractive synthesizer) -> render with verifiable citations -> persist.
import { currentSessionId, loadCurrentSession, persistMessage, refreshSyncStatus, startNewSession } from './chat-store.js';
import { APP_VERSION, LIMITS } from './config.js';
import { contextCoverage } from './core/grounding.js';
import { byId, onAction, onChange, setHidden } from './dom.js';
import { refreshIcons } from './icons.js';
import { startLocalEngine } from './engine-ui.js';
import { getLocale, hasKey, setText, t } from './i18n/index.js';
import { appendLoading, appendMessage, appendNotice, createStreamingMessage, resetMessages, splitReasoning } from './messages.js';
import { buildInstructions, buildSystemPrompt, contextSection } from './prompts.js';
import { callGemini, callLocalServer, callOpenRouter, hasGeminiKey, hasOpenRouterKey } from './providers.js';
import { registerCitations } from './rag/citations.js';
import { applyGrounding } from './rag/grounding-view.js';
import { receiptButton, storeReceiptDraft } from './rag/receipts.js';
import { addToWorkspace, firstChunks, listWorkspace, searchWorkspace } from './rag/workspace.js';
import { sanitizeModelNames } from './render.js';
import { assignCitations, buildContext, distinctSources, mergeHits, rankHitsLocally, workspaceHit } from './retrieval.js';
import { isUserAbort } from './signals.js';
import { getLlmUrl, getMode } from './state.js';
import { getConnection, listDocuments, recentKnowledge, searchKnowledge } from './supabase.js';
import { describeTrace, isGreeting, synthesizeAnswer } from './synthesizer.js';
import { setAssistantStatus } from './ui.js';
import * as engine from './webgpu/engine.js';
import { budgetPrompt } from './webgpu/models.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {{ role: 'user' | 'assistant', content: string, localOnly?: boolean }} Turn */

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

  // Local mode: candidates are fetched without the question and ranked in the browser.
  const recent = await recentKnowledge(30);
  const ranked = recent.ok ? rankHitsLocally(query, recent.data, LIMITS.retrievalRows) : [];
  return result(merge(ranked), t(recent.ok ? 'retrieval.local' : 'retrieval.offline'), !recent.ok);
}

/**
 * @typedef {object} Answer
 * @property {string} text
 * @property {'cloud' | 'client' | 'local' | 'synthesizer'} engine
 * @property {boolean} [rendered] already rendered by a streaming bubble
 * @property {HTMLElement} [element] the message element of a streamed answer
 * @property {string} [deliveredContext] the context actually sent, when it was trimmed to fit the model
 * @property {string} [note]
 */

/**
 * The last turns that may leave the device: turns that stayed on it (on-device mode, workspace
 * excerpts, attached files) are never sent to a cloud provider or a server as history.
 * @param {Turn[]} history
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
function shareableHistory(history) {
  return history
    .filter((h) => !h.localOnly)
    .slice(-4)
    .map(({ role, content }) => ({ role, content }));
}

/**
 * @param {{ prompt: string, context: string, history: Turn[], signal: AbortSignal }} req
 * @returns {Promise<Answer | null>}
 */
async function answerWithCloud(req) {
  const system = buildSystemPrompt({ locale: getLocale(), target: 'cloud', context: req.context });
  /** @type {string | null} */
  let geminiFailure = null;
  if (hasGeminiKey()) {
    try {
      const r = await callGemini(`${system}\n\n${t('prompt.user_question')}\n${req.prompt}`, { signal: req.signal });
      return { text: r.text, engine: 'cloud' };
    } catch (err) {
      if (req.signal.aborted) throw err;
      geminiFailure = sanitizeModelNames(err instanceof Error ? err.message : String(err)).slice(0, 160);
      console.warn('[starpi] Gemini failed, trying the next provider:', geminiFailure);
    }
  }
  if (hasOpenRouterKey()) {
    try {
      const r = await callOpenRouter([{ role: 'system', content: system }, ...shareableHistory(req.history), { role: 'user', content: req.prompt }], {
        signal: req.signal,
      });
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
    return { text, engine: 'client', rendered: true, element: stream.element, deliveredContext: budget.context };
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
        ...shareableHistory(req.history),
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
  const input = byId('chatInput');
  // Disabling the focused Send button would drop keyboard focus to <body>; keep it in the input.
  if (on && send && document.activeElement === send) input?.focus();
  if (send) send.disabled = on;
  if (!on && document.activeElement === document.body) input?.focus();
  byId('chatMessages')?.setAttribute('aria-busy', String(on));
  setAssistantStatus(on ? 'status.generating' : 'status.ready');
}

/**
 * @param {string} rawText
 * @param {{ workspaceOnly?: boolean }} [options]  workspaceOnly: search only the on-device workspace
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
  const localOnly = mode === 'client';
  const prompt = userText || t('chat.summarize_file', { name: file?.name ?? '' });
  const shownText = file ? `${prompt}\n\n[${file.name}]` : prompt;

  appendMessage('user', shownText);
  // The question follows its answer's storage rule, so it is stored once retrieval shows whether
  // workspace excerpts are involved: a question about the workspace (or naming an attached file)
  // stays on this device like its answer.
  let questionStored = false;
  const storeQuestion = (/** @type {boolean} */ usesWorkspace) => {
    if (questionStored) return;
    questionStored = true;
    void persistMessage(sid, { role: 'user', content: shownText, sources: [], metadata: {} }, { localOnly: localOnly || Boolean(file) || usesWorkspace });
  };

  const controller = new AbortController();
  activeAbort = controller;
  setBusy(true);
  const removeLoading = appendLoading();
  const started = performance.now();

  try {
    const { hits, method, kbUnavailable } = await retrieve(prompt, mode, file?.docId ?? null, options.workspaceOnly === true);
    const greeting = !file && isGreeting(userText);
    const used = greeting ? [] : hits;
    const usesWorkspace = used.some((h) => h.workspace);
    storeQuestion(usesWorkspace);
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
    if (controller.signal.aborted && !answer.rendered) throw new DOMException('Aborted', 'AbortError');

    const durationMs = Math.round(performance.now() - started);
    const answerText = splitReasoning(answer.text).answer || answer.text;
    const trace = describeTrace({ query: prompt, method, hits: used, engineLabel: t(ENGINE_LABELS[answer.engine]), durationMs, note });
    const metadata = { engine: answer.engine, thoughts: trace, duration_ms: durationMs };

    if (sid === currentSessionId()) {
      /** @type {HTMLElement | null} */
      let messageEl = answer.element ?? null;
      if (!answer.rendered) {
        removeLoading();
        messageEl = appendMessage('assistant', answer.text, { citations, badge: ENGINE_LABELS[answer.engine], trace, durationMs });
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
      const turnLocal = localOnly || usesWorkspace || Boolean(file);
      conversation.push({ role: 'user', content: prompt.slice(0, 4_000), localOnly: turnLocal }, { role: 'assistant', content: answerText, localOnly: turnLocal });
    }

    // Answers quoting the on-device workspace stay on this device, even when chats are synced.
    void persistMessage(sid, { role: 'assistant', content: answerText, sources, metadata }, { localOnly: localOnly || usesWorkspace });
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
    conversation.push({ role: m.role, content: m.content, localOnly: m.metadata?.local_only === true });
  }
  container?.append(...shownSinceBoot);
  conversation.push(...live);
}

/**
 * Grows the message box with its text, up to its max-height (then it scrolls).
 * @param {HTMLTextAreaElement} input
 */
function autosize(input) {
  input.style.height = 'auto';
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
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

  // Quick prompts carry an i18n key, so the question is asked in the active language. Questions about
  // the sample files (data-scope="workspace") search only the workspace.
  onAction('quick-prompt', (el) => {
    const key = el.dataset.arg ?? '';
    if (key) void submitChat(hasKey(key) ? t(key) : key, { workspaceOnly: el.dataset.scope === 'workspace' });
  });

  onChange('attach-file', (el) => {
    const fileInput = /** @type {HTMLInputElement} */ (el);
    const file = fileInput.files?.[0];
    fileInput.value = '';
    return file ? attachFile(file) : undefined;
  });
}
