// @ts-check
// A brain for any server that speaks the OpenAI chat-completions dialect: local servers on this
// machine (Ollama, llama.cpp, LM Studio, vLLM) and the cloud presets. When a secret is configured,
// its value from the vault goes out as `Authorization: Bearer`; without one no Authorization header
// is sent. Reasoning that a server streams separately (`reasoning_content` or `reasoning`) is kept
// apart from the answer text.
import { checkBrainRequest, providerError, transportError } from './contract.js';
import { guardStream, readSse } from './sse.js';
import { mapStopReason } from './stop-reasons.js';
import { fail } from '../lib/errors.js';
import { trimTrailingSlashes } from '../lib/text.js';

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.baseUrl              e.g. http://127.0.0.1:11434/v1
 * @param {string} options.model
 * @param {'local' | 'cloud'} options.locality
 * @param {typeof globalThis.fetch} options.fetch           the plain fetch for local servers, an egress capability's for cloud ones
 * @param {() => string | null} [options.apiKey]
 * @param {readonly string[]} [options.hosts]
 * @param {number} [options.memoryMb]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.kind]
 * @returns {import('./contract.js').Brain}
 */
export function createOpenAiCompatBrain({ id, baseUrl, model, locality, fetch, apiKey = () => null, hosts = [], memoryMb, timeoutMs = 300_000, kind = 'openai-compat' }) {
  const endpoint = `${trimTrailingSlashes(baseUrl)}/chat/completions`;
  return {
    id,
    kind,
    locality,
    model,
    hosts,
    memoryMb,
    async *stream(request, { signal }) {
      const req = checkBrainRequest(request);
      /** @type {Record<string, string>} */
      const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
      const key = apiKey();
      if (key) headers.authorization = `Bearer ${key}`;
      /** @type {Record<string, unknown>} */
      const body = { model, messages: req.messages.map((m) => ({ role: m.role, content: m.content })), stream: true, stream_options: { include_usage: true } };
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      let response;
      try {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      } catch (err) {
        throw transportError(id, err, signal);
      }
      if (!response.ok) throw await providerError(id, response);
      /** @type {import('./stop-reasons.js').StopReason | null} */
      let stop = null;
      /** @type {string | null} */
      let served = null;
      /** @type {{ input: number, output: number } | null} */
      let usage = null;
      for await (const sse of guardStream(readSse(response.body), id, signal)) {
        if (sse.data === '[DONE]') break;
        let chunk;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          throw fail('brain_bad_response', `${id} sent a stream chunk that is not JSON`, { status: 502 });
        }
        if (chunk?.error) throw fail('brain_unavailable', `${id} reported an error in the stream`, { status: 502 });
        if (typeof chunk?.model === 'string') served = chunk.model;
        if (chunk?.usage && typeof chunk.usage.prompt_tokens === 'number') usage = { input: chunk.usage.prompt_tokens, output: Number(chunk.usage.completion_tokens ?? 0) };
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
        const delta = choice?.delta ?? {};
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === 'string' && thought !== '') yield { type: 'reasoning', text: thought };
        if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', text: delta.content };
        if (choice?.finish_reason) stop = mapStopReason('openai', choice.finish_reason);
      }
      yield { type: 'end', stopReason: stop ?? 'error', model: served ?? model, usage };
    },
  };
}
