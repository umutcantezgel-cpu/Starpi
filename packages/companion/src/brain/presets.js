// @ts-check
// Cloud providers that speak the OpenAI chat-completions dialect, by preset name: the base URL, the
// one host the brain needs on the egress list, and a default model (the owner may name another).

/** @typedef {{ baseUrl: string, model: string }} Preset */

/** @type {Readonly<Record<string, Readonly<Preset>>>} */
export const CLOUD_PRESETS = Object.freeze({
  openai: Object.freeze({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' }),
  groq: Object.freeze({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' }),
  mistral: Object.freeze({ baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-latest' }),
  deepseek: Object.freeze({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
  openrouter: Object.freeze({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' }),
  xai: Object.freeze({ baseUrl: 'https://api.x.ai/v1', model: 'grok-4-fast-reasoning' }),
  nvidia: Object.freeze({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' }),
});

/** The host:443 entry of a preset. @param {string} name */
export const presetHost = (name) => `${new URL(CLOUD_PRESETS[name].baseUrl).hostname}:443`;
