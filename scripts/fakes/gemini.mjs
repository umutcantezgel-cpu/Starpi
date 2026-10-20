#!/usr/bin/env node
// Fake of the Gemini API (v1beta) on 127.0.0.1: models/<id>:streamGenerateContent (server-sent
// events with ?alt=sse, a JSON array without), models/<id>:generateContent, GET /v1beta/models and
// GET /v1beta/models/<id>. The key must come in the x-goog-api-key header; a key in the URL is
// refused, so an adapter that puts it there fails in tests.
//
// Scenarios (see shared.mjs): text (default), reasoning (thought parts when the request asks for
// thoughts, a thoughtSignature on the first answer part either way), tool (a functionCall part with
// its thoughtSignature), search (groundingMetadata with chunks, supports and a search entry point;
// chosen automatically when the request offers google_search), refusal (finishReason SAFETY),
// blocked (promptFeedback.blockReason, no candidate), recitation, length (MAX_TOKENS), image (an
// inlineData PNG; also when responseModalities asks for IMAGE). A request whose responseModalities
// asks for AUDIO gets PCM speech (the TTS models). Faults: see shared.mjs; 429 also carries the
// retry delay in the body as structured retry info.
//
// groundingSupports segments count UTF-8 bytes, as the real API does, not UTF-16 code units.
//
// Speech: a request with an audio inlineData part (and no AUDIO answer asked for) gets a fixed
// transcript, in German when the instruction names German. POST /v1alpha/auth_tokens (and v1beta)
// issues single-use Live tokens for a bidiGenerateContentSetup; the Live socket
// /ws/google.ai.generativelanguage.<version>.GenerativeService.BidiGenerateContentConstrained takes
// such a token as ?access_token= (a key in the URL is refused), wants { setup } with the token's
// model first, answers setupComplete, and after each user turn (activityEnd, audioStreamEnd, text
// input or clientContent) sends an input transcript, the answer as PCM audio or text parts by the
// setup's responseModalities, an output transcript and turnComplete. Markers in the setup's system
// instruction steer it: [[fake:interrupt]] sends interrupted in the middle of each answer,
// [[fake:goaway]] sends goAway after setupComplete, [[fake:refuse]] closes with 1008 after setup.
//
// Usage: node scripts/fakes/gemini.mjs [--port 4613] [--marker starpi-purpose] [--fixtures dir]
// API root for clients: http://127.0.0.1:<port> (paths /v1beta/...)
import { chunkText, createAnswerBook, createFakeServer, isMain, pcmSilence, REASONING_TEXT, refusalText, runStandalone, SEARCH_SOURCES, searchSentences, TINY_PNG_BASE64 } from './shared.mjs';
import { acceptWebSocket, refuseUpgrade } from './ws.mjs';

export const DEFAULT_PORT = 4613;

export const FAKE_MODELS = Object.freeze([
  { id: 'gemini-fake-flash', methods: ['generateContent', 'streamGenerateContent', 'countTokens'], input: 1_048_576, output: 65_536, thinking: true },
  { id: 'gemini-fake-pro', methods: ['generateContent', 'streamGenerateContent', 'countTokens'], input: 1_048_576, output: 65_536, thinking: true },
  { id: 'gemini-fake-image', methods: ['generateContent', 'streamGenerateContent'], input: 32_768, output: 8_192, thinking: false },
  { id: 'gemini-fake-tts', methods: ['generateContent'], input: 8_192, output: 16_384, thinking: false },
  { id: 'gemini-fake-live', methods: ['bidiGenerateContent'], input: 32_768, output: 8_192, thinking: false },
]);

/** What the fake hears in an audio recording or a Live turn. */
export const FAKE_TRANSCRIPTS = Object.freeze({ en: 'This is a simulated transcript.', de: 'Dies ist ein simuliertes Transkript.' });
/** What a Live turn answers. */
export const FAKE_LIVE_ANSWERS = Object.freeze({ en: 'This is a simulated live answer.', de: 'Dies ist eine simulierte Live-Antwort.' });
const LIVE_PATH = /^\/ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.BidiGenerateContentConstrained$/;

const STATUS_NAMES = /** @type {Record<number, string>} */ ({ 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 413: 'INVALID_ARGUMENT', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' });

/**
 * @param {number} status
 * @param {string} message
 * @param {number} [retryS]
 */
function errorBody(status, message, retryS) {
  /** @type {Record<string, unknown>} */
  const error = { code: status, message, status: STATUS_NAMES[status] ?? 'UNKNOWN' };
  if (status === 429) error.details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retryS ?? 2}s` }];
  return { error };
}

/** @param {any} content */
const partsText = (content) => (Array.isArray(content?.parts) ? content.parts.map((/** @type {any} */ p) => (typeof p?.text === 'string' && !p.thought ? p.text : '')).join('') : '');

/** @param {string} text */
const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

/**
 * Creates the fake (not yet listening).
 * @param {{ marker?: string, fixtures?: any, fixturesDir?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createGeminiFake(options = {}) {
  const book = createAnswerBook(options);
  let counter = 0;
  /** @type {Map<string, { setup: any, uses: number, expires: number }>} */
  const liveTokens = new Map();

  const fake = createFakeServer(
    {
      name: 'gemini',
      texts: ({ json }) => {
        const users = Array.isArray(json?.contents) ? json.contents.filter((/** @type {any} */ c) => (c?.role ?? 'user') === 'user') : [];
        return users.length ? [partsText(users[users.length - 1])] : [];
      },
      auth: ({ req, url }) => {
        if (url.searchParams.has('key')) return 'in_query';
        const key = req.headers['x-goog-api-key'];
        return typeof key === 'string' && key.length > 0 ? 'ok' : 'missing';
      },
      errorBody: (status, kind, control) =>
        errorBody(status, kind === 'key_in_query' ? 'Simulated: send the key in the x-goog-api-key header, not in the URL.' : `Simulated ${kind} error.`, control?.retryAfterS),
      async handle(ctx) {
        const method = ctx.req.method;
        if (method === 'GET' && /^\/v1(?:beta|alpha)?\/models$/.test(ctx.path)) {
          return ctx.send(200, { models: FAKE_MODELS.map(describe) });
        }
        const one = /^\/v1(?:beta|alpha)?\/models\/([A-Za-z0-9.-]+)$/.exec(ctx.path);
        if (method === 'GET' && one) {
          const model = FAKE_MODELS.find((m) => m.id === one[1]);
          return model ? ctx.send(200, describe(model)) : ctx.fail(404, 'not_found');
        }
        if (method === 'POST' && /^\/v1(?:alpha|beta)\/auth_tokens$/.test(ctx.path)) return issueToken(ctx);
        const call = /^\/v1(?:beta|alpha)?\/models\/([A-Za-z0-9.-]+):(generateContent|streamGenerateContent|countTokens)$/.exec(ctx.path);
        if (method !== 'POST' || !call) return false;
        if (!ctx.json || !Array.isArray(ctx.json.contents) || ctx.json.contents.length === 0) return ctx.send(400, errorBody(400, 'contents is not specified'));
        if (call[2] === 'countTokens') return ctx.send(200, { totalTokens: tokens(ctx.json.contents.map(partsText).join('')) });
        counter += 1;
        return generate(ctx, call[1], call[2] === 'streamGenerateContent', counter);
      },
    },
    options,
  );

  /** @type {Set<import('node:stream').Duplex>} */
  const liveSockets = new Set();
  fake.server.on('upgrade', (req, socket, head) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
    liveSocket(req, socket, head);
  });
  const closeHttp = fake.close;
  // Upgraded sockets are not HTTP connections any more: end them first, or close() waits for them.
  fake.close = () => {
    for (const socket of liveSockets) socket.destroy();
    liveSockets.clear();
    return closeHttp();
  };
  return fake;

  /** @param {import('./shared.mjs').FakeContext} ctx */
  function issueToken(ctx) {
    const body = ctx.json;
    const setup = body?.bidiGenerateContentSetup?.setup ?? body?.bidiGenerateContentSetup;
    if (!setup || typeof setup !== 'object' || typeof setup.model !== 'string') return ctx.send(400, errorBody(400, 'bidiGenerateContentSetup with a model is required'));
    counter += 1;
    const name = `auth_tokens/fake${String(counter).padStart(6, '0')}`;
    const expires = Date.parse(body.expireTime ?? '') || Date.now() + 30 * 60_000;
    liveTokens.set(name, { setup, uses: Number.isInteger(body.uses) && body.uses > 0 ? body.uses : 1, expires });
    return ctx.send(200, { name, uses: body.uses ?? 1, expireTime: new Date(expires).toISOString(), newSessionExpireTime: body.newSessionExpireTime ?? null });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  function liveSocket(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!LIVE_PATH.test(url.pathname)) return refuseUpgrade(socket, 404, 'Not Found');
    if (url.searchParams.has('key')) return refuseUpgrade(socket, 400, 'Bad Request');
    const name = url.searchParams.get('access_token') ?? '';
    const token = liveTokens.get(name);
    if (!token || token.uses < 1 || token.expires < Date.now()) return refuseUpgrade(socket, 401, 'Unauthorized');
    token.uses -= 1;
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    options.log?.(`gemini live ${url.pathname} open`);
    const instruction = (token.setup.systemInstruction?.parts ?? []).map((/** @type {any} */ p) => String(p?.text ?? '')).join(' ');
    const marker = /\[\[fake:([a-z0-9-]+)\]\]/i.exec(instruction)?.[1]?.toLowerCase() ?? null;
    const german = /\bgerman\b|\bdeutsch\b/i.test(instruction) || /^de/i.test(String(token.setup.generationConfig?.speechConfig?.languageCode ?? ''));
    const modalities = (token.setup.generationConfig?.responseModalities ?? ['AUDIO']).map((/** @type {unknown} */ m) => String(m).toUpperCase());
    let ready = false;
    let audioBytes = 0;
    let typed = '';
    /** @param {unknown} message */
    const send = (message) => ws.send(JSON.stringify(message));

    const answerTurn = () => {
      const heard = typed || (audioBytes > 0 ? (german ? FAKE_TRANSCRIPTS.de : FAKE_TRANSCRIPTS.en) : '');
      typed = '';
      audioBytes = 0;
      if (heard) send({ serverContent: { inputTranscription: { text: heard } } });
      const answer = german ? FAKE_LIVE_ANSWERS.de : FAKE_LIVE_ANSWERS.en;
      const pieces = chunkText(answer);
      pieces.forEach((piece, i) => {
        if (marker === 'interrupt' && i === Math.floor(pieces.length / 2)) {
          send({ serverContent: { interrupted: true } });
          return;
        }
        if (modalities.includes('TEXT')) send({ serverContent: { modelTurn: { parts: [{ text: piece }] } } });
        else send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmSilence(120).toString('base64') } }] } } });
        if (!modalities.includes('TEXT')) send({ serverContent: { outputTranscription: { text: piece } } });
      });
      send({ serverContent: { generationComplete: true } });
      send({ serverContent: { turnComplete: true } });
    };

    ws.onMessage((data) => {
      let message;
      try {
        message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return ws.close(1007, 'messages must be JSON');
      }
      if (!ready) {
        if (!message?.setup || message.setup.model !== token.setup.model) return ws.close(1008, 'the setup does not match the token');
        ready = true;
        send({ setupComplete: {} });
        if (marker === 'refuse') return ws.close(1008, 'simulated refusal');
        if (marker === 'goaway') send({ goAway: { timeLeft: '5s' } });
        return;
      }
      const input = message.realtimeInput;
      if (input?.audio?.data) audioBytes += Math.floor((String(input.audio.data).length * 3) / 4);
      if (typeof input?.text === 'string' && input.text.trim()) {
        typed = input.text.trim();
        answerTurn();
      }
      if (input?.activityEnd || input?.audioStreamEnd) answerTurn();
      if (message.clientContent?.turnComplete) {
        const turns = Array.isArray(message.clientContent.turns) ? message.clientContent.turns : [];
        typed = turns.flatMap((/** @type {any} */ turn) => (Array.isArray(turn?.parts) ? turn.parts : [])).map((/** @type {any} */ p) => String(p?.text ?? '')).join(' ').trim();
        answerTurn();
      }
    });
  }

  /** @param {(typeof FAKE_MODELS)[number]} m */
  function describe(m) {
    return { name: `models/${m.id}`, version: '001', displayName: m.id, description: 'Simulated model.', inputTokenLimit: m.input, outputTokenLimit: m.output, supportedGenerationMethods: m.methods, thinking: m.thinking, temperature: 1, maxTemperature: 2 };
  }

  /**
   * @param {import('./shared.mjs').FakeContext} ctx
   * @param {string} model
   * @param {boolean} streaming
   * @param {number} n
   */
  function generate(ctx, model, streaming, n) {
    const body = ctx.json;
    const contents = /** @type {any[]} */ (body.contents);
    const users = contents.filter((c) => (c?.role ?? 'user') === 'user');
    const user = users.length ? partsText(users[users.length - 1]) : '';
    const system = partsText(body.systemInstruction);
    const last = contents[contents.length - 1];
    const afterTool = Array.isArray(last?.parts) && last.parts.some((/** @type {any} */ p) => p?.functionResponse);
    /** @type {any[]} */
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declarations = tools.flatMap((t) => (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []));
    const searchTool = tools.some((t) => t?.google_search || t?.googleSearch);
    const config = body.generationConfig ?? {};
    const modalities = Array.isArray(config.responseModalities) ? config.responseModalities.map((/** @type {unknown} */ m) => String(m).toUpperCase()) : [];
    const thoughts = config.thinkingConfig?.includeThoughts === true;
    const thinkingAsked = Boolean(config.thinkingConfig) && config.thinkingConfig.thinkingBudget !== 0;

    const lastUser = users[users.length - 1];
    const audioIn = Array.isArray(lastUser?.parts) && lastUser.parts.some((/** @type {any} */ p) => /^audio\//i.test(String(p?.inlineData?.mimeType ?? '')));
    let scenario = ctx.control.scenario ?? (modalities.includes('AUDIO') ? 'audio' : audioIn ? 'transcribe' : modalities.includes('IMAGE') ? 'image' : searchTool ? 'search' : 'text');
    if (afterTool || (scenario === 'tool' && declarations.length === 0)) scenario = 'text';
    const thinking = scenario === 'reasoning' || thinkingAsked;
    const signature = `fake-thought-${n}`;
    const usage = { promptTokenCount: tokens(system + user), candidatesTokenCount: 0, totalTokenCount: 0, ...(thinking ? { thoughtsTokenCount: tokens(REASONING_TEXT) } : {}) };
    const head = { modelVersion: model, responseId: `resp-${n}-fake` };

    /** @type {Array<Record<string, unknown>>} */
    const chunks = [];
    /** @param {any[]} parts */
    const candidate = (parts) => ({ candidates: [{ content: { role: 'model', parts }, index: 0 }], usageMetadata: usage, ...head });
    /** @param {Record<string, unknown>} fields */
    const finish = (fields) => chunks.push({ candidates: [{ content: { role: 'model', parts: [] }, index: 0, ...fields }], usageMetadata: usage, ...head });
    if (thinking && thoughts) for (const piece of chunkText(REASONING_TEXT)) chunks.push(candidate([{ text: piece, thought: true }]));
    /** @param {string} text */
    const answerChunks = (text) => chunkText(text).forEach((piece, i) => chunks.push(candidate([{ text: piece, ...(i === 0 && thinking ? { thoughtSignature: signature } : {}) }])));
    /** @type {string} */
    let answered = '';

    switch (scenario) {
      case 'blocked':
        chunks.length = 0;
        chunks.push({ promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }] }, usageMetadata: usage, ...head });
        break;
      case 'refusal':
        finish({ finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }] });
        answered = refusalText(user);
        break;
      case 'recitation':
        answerChunks('The beginning of a well-known text');
        finish({ finishReason: 'RECITATION' });
        break;
      case 'tool': {
        const fn = declarations[0];
        const query = user.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 60) || 'example';
        chunks.push(candidate([{ functionCall: { name: fn.name, args: { query } }, thoughtSignature: signature }]));
        finish({ finishReason: 'STOP' });
        break;
      }
      case 'search': {
        let at = 0;
        const sentences = searchSentences(user);
        const supports = sentences.map((s) => {
          const start = at + (s.text.startsWith(' ') ? 1 : 0);
          at += Buffer.byteLength(s.text);
          return { segment: { startIndex: start, endIndex: at, text: s.text.trim() }, groundingChunkIndices: [s.source] };
        });
        answered = sentences.map((s) => s.text).join('');
        answerChunks(answered);
        finish({
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: [user.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 60) || 'example'],
            searchEntryPoint: { renderedContent: '<div class="fake-search-entry">Simulated search suggestions</div>' },
            groundingChunks: SEARCH_SOURCES.map((s) => ({ web: { uri: s.url, title: s.title } })),
            groundingSupports: supports,
          },
        });
        break;
      }
      case 'transcribe':
        answered = /\bgerman\b/i.test(system) ? FAKE_TRANSCRIPTS.de : FAKE_TRANSCRIPTS.en;
        answerChunks(answered);
        finish({ finishReason: 'STOP' });
        break;
      case 'image':
        chunks.push(candidate([{ text: 'Here is a simple test image.' }]));
        chunks.push(candidate([{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }]));
        finish({ finishReason: 'STOP' });
        break;
      case 'audio': {
        const text = user || 'Hello';
        chunks.push(candidate([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmSilence(Math.min(10_000, 200 + text.length * 40)).toString('base64') } }]));
        finish({ finishReason: 'STOP' });
        break;
      }
      default: {
        const schema = config.responseJsonSchema ?? config.responseSchema ?? (config.responseMimeType === 'application/json' ? { type: 'object' } : null);
        const { text } = book.answer({ system, user, schema });
        answered = scenario === 'length' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text;
        answerChunks(answered);
        finish({ finishReason: scenario === 'length' ? 'MAX_TOKENS' : 'STOP' });
      }
    }
    usage.candidatesTokenCount = tokens(answered || 'x');
    usage.totalTokenCount = usage.promptTokenCount + usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);

    const headers = { 'x-request-id': `req_${n}fake` };
    if (streaming && ctx.url.searchParams.get('alt') === 'sse') return ctx.sse(chunks.map((data) => ({ data })), headers);
    if (streaming) return ctx.send(200, chunks, headers);
    return ctx.send(200, merge(chunks), headers);
  }
}

/**
 * The single answer generateContent returns: the streamed chunks folded into one candidate.
 * @param {Array<Record<string, any>>} chunks
 */
function merge(chunks) {
  const lastChunk = chunks[chunks.length - 1] ?? {};
  if (!lastChunk.candidates) return lastChunk;
  const parts = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
  /** @type {any[]} */
  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (prev && typeof prev.text === 'string' && typeof part.text === 'string' && Boolean(prev.thought) === Boolean(part.thought) && !part.thoughtSignature) prev.text += part.text;
    else merged.push({ ...part });
  }
  return { ...lastChunk, candidates: [{ ...lastChunk.candidates[0], content: { role: 'model', parts: merged } }] };
}

if (isMain(import.meta.url)) {
  await runStandalone('gemini', (common) => createGeminiFake({ ...common, log: (l) => console.log(l) }), { envPort: 'FAKE_GEMINI_PORT', defaultPort: DEFAULT_PORT });
}
