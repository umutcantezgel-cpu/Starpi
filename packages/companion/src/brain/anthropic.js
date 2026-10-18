// @ts-check
// A brain for Anthropic's Messages API through the official SDK (@anthropic-ai/sdk, loaded when the
// first request needs it). The SDK gets the egress capability's fetch, so its requests can reach
// the API host the owner listed and nothing else. The model is configurable; the default is the
// current Opus model. Thinking stays adaptive (the current models do not switch it off); `effort`
// sets its depth, and `showReasoning` asks for a summarized view of it.
//
// No server-side fallback to another model is requested: a request the model declines comes back
// as a refusal, never as an answer of a different model the owner did not choose.
import { checkBrainRequest, splitSystem, transportError } from './contract.js';
import { guardStream } from './sse.js';
import { mapStopReason } from './stop-reasons.js';
import { fail } from '../lib/errors.js';

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * @param {object} options
 * @param {string} options.id
 * @param {typeof fetch} options.fetch
 * @param {() => string | null} options.apiKey
 * @param {string} [options.model]
 * @param {string} [options.effort]
 * @param {boolean} [options.showReasoning]
 * @param {string} [options.baseUrl]
 * @param {() => Promise<any>} [options.loadSdk]
 * @param {number} [options.timeoutMs]
 * @returns {import('./contract.js').Brain}
 */
export function createAnthropicBrain({ id, fetch, apiKey, model = DEFAULT_ANTHROPIC_MODEL, effort, showReasoning = false, baseUrl = `https://${ANTHROPIC_HOST}`, loadSdk = () => import('@anthropic-ai/sdk'), timeoutMs = 600_000 }) {
  if (effort !== undefined && !EFFORTS.includes(effort)) throw fail('brain_config', `effort is one of ${EFFORTS.join(', ')}`);
  return {
    id,
    kind: 'anthropic',
    locality: 'cloud',
    model,
    hosts: [`${new URL(baseUrl).hostname}:443`],
    async *stream(request, { signal }) {
      const req = checkBrainRequest(request);
      const key = apiKey();
      if (!key) throw fail('brain_auth', `${id} has no API key in the vault`, { status: 502 });
      const mod = await loadSdk();
      const Anthropic = mod.default ?? mod.Anthropic;
      const client = new Anthropic({ apiKey: key, baseURL: baseUrl, fetch, maxRetries: 0, timeout: timeoutMs, logLevel: 'off' });
      const { system, turns } = splitSystem(req.messages);
      if (turns.length === 0) throw fail('brain_request_invalid', 'a request needs at least one user turn', { status: 400 });
      /** @type {Record<string, unknown>} */
      const body = { model, max_tokens: req.maxTokens ?? 64_000, messages: turns.map((m) => ({ role: m.role, content: m.content })), stream: true };
      if (system) body.system = system;
      if (effort) body.output_config = { effort };
      if (showReasoning) body.thinking = { type: 'adaptive', display: 'summarized' };
      let events;
      try {
        events = await client.messages.create(body, { signal });
      } catch (err) {
        throw transportError(id, err, signal);
      }
      /** @type {string | null} */
      let served = null;
      let input = 0;
      let output = 0;
      /** @type {import('./stop-reasons.js').StopReason | null} */
      let stop = null;
      for await (const event of guardStream(events, id, signal)) {
        switch (event?.type) {
          case 'message_start':
            served = event.message?.model ?? served;
            input = Number(event.message?.usage?.input_tokens ?? 0);
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text) yield { type: 'text', text: event.delta.text };
            else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) yield { type: 'reasoning', text: event.delta.thinking };
            break;
          case 'message_delta':
            if (event.delta?.stop_reason) stop = mapStopReason('anthropic', event.delta.stop_reason);
            output = Number(event.usage?.output_tokens ?? output);
            break;
          default:
            break;
        }
      }
      yield { type: 'end', stopReason: stop ?? 'error', model: served ?? model, usage: { input, output } };
    },
  };
}
