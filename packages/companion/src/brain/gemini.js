// @ts-check
// A brain for the Gemini API (generativelanguage.googleapis.com), streaming with `alt=sse`. The key
// from the vault goes in the x-goog-api-key header, never in the URL. Thought summaries, when asked
// for, arrive as parts marked `thought` and are kept apart from the answer.
import { checkBrainRequest, providerError, splitSystem, transportError } from './contract.js';
import { guardStream, readSse } from './sse.js';
import { mapStopReason } from './stop-reasons.js';
import { fail } from '../lib/errors.js';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,80}$/;

/**
 * @param {object} options
 * @param {string} options.id
 * @param {typeof globalThis.fetch} options.fetch
 * @param {() => string | null} options.apiKey
 * @param {string} [options.model]
 * @param {boolean} [options.showReasoning]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 * @returns {import('./contract.js').Brain}
 */
export function createGeminiBrain({ id, fetch, apiKey, model = DEFAULT_GEMINI_MODEL, showReasoning = false, baseUrl = `https://${GEMINI_HOST}`, timeoutMs = 300_000 }) {
  if (!MODEL_ID.test(model)) throw fail('brain_config', `${JSON.stringify(model)} is not a Gemini model id`);
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  return {
    id,
    kind: 'gemini',
    locality: 'cloud',
    model,
    hosts: [`${new URL(baseUrl).hostname}:443`],
    async *stream(request, { signal }) {
      const req = checkBrainRequest(request);
      const key = apiKey();
      if (!key) throw fail('brain_auth', `${id} has no API key in the vault`, { status: 502 });
      const { system, turns } = splitSystem(req.messages);
      /** @type {Record<string, unknown>} */
      const generationConfig = {};
      if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      if (showReasoning) generationConfig.thinkingConfig = { includeThoughts: true };
      /** @type {Record<string, unknown>} */
      const body = { contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (err) {
        throw transportError(id, err, signal);
      }
      if (!response.ok) throw await providerError(id, response);
      /** @type {import('./stop-reasons.js').StopReason | null} */
      let stop = null;
      /** @type {{ input: number, output: number } | null} */
      let usage = null;
      let served = model;
      for await (const sse of guardStream(readSse(response.body), id, signal)) {
        let chunk;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          throw fail('brain_bad_response', `${id} sent a stream chunk that is not JSON`, { status: 502 });
        }
        if (typeof chunk?.modelVersion === 'string') served = chunk.modelVersion;
        if (chunk?.usageMetadata) usage = { input: Number(chunk.usageMetadata.promptTokenCount ?? 0), output: Number(chunk.usageMetadata.candidatesTokenCount ?? 0) };
        if (chunk?.promptFeedback?.blockReason) stop = 'refusal';
        const candidate = Array.isArray(chunk?.candidates) ? chunk.candidates[0] : null;
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part?.text !== 'string' || part.text === '') continue;
          yield part.thought ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text };
        }
        if (candidate?.finishReason) stop = mapStopReason('gemini', candidate.finishReason);
      }
      yield { type: 'end', stopReason: stop ?? 'error', model: served, usage };
    },
  };
}
