// @ts-check
// The built-in adapter of every provider, and a helper that registers them all with the AI layer's
// registry (src/js/ai/index.js). The Anthropic adapter loads its SDK only when a call runs, the
// on-device adapters load their engines the same way and the companion adapter its pairing, so
// importing this module stays cheap.
import { registerAdapter } from '../index.js';
import { getProvider, PROVIDER_ORDER } from '../catalog/providers.js';
import { createLocalQuirks, getQuirks } from '../quirks/index.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createCompanionAdapter } from './companion.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAiChatAdapter } from './openai-chat.js';
import { createOpenAiResponsesAdapter } from './openai-responses.js';
import { createWasmAdapter } from './wasm.js';
import { createWebllmAdapter } from './webllm.js';

/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../stream.js').Adapter} Adapter */

/**
 * @typedef {object} BuiltInOptions
 * @property {import('./anthropic.js').AnthropicOptions} [anthropic]  e.g. { serverFallbacks: true } for the site's BYOK chat
 * @property {import('../quirks/local.js').LocalQuirkOptions} [local]
 * @property {import('./on-device.js').OnDeviceOptions} [onDevice]
 * @property {import('./companion.js').CompanionAdapterOptions} [companion]
 */

/**
 * The built-in adapter of a provider.
 * @param {ProviderId} provider
 * @param {BuiltInOptions} [options]
 * @returns {Adapter}
 */
export function createAdapter(provider, options = {}) {
  switch (provider) {
    case 'anthropic':
      return createAnthropicAdapter(options.anthropic);
    case 'openai':
      return createOpenAiResponsesAdapter();
    case 'gemini':
      return createGeminiAdapter();
    case 'webgpu':
      return createWebllmAdapter(options.onDevice);
    case 'wasm':
      return createWasmAdapter(options.onDevice);
    case 'local':
      return createOpenAiChatAdapter({ provider, quirks: createLocalQuirks(options.local) });
    case 'companion':
      return createCompanionAdapter(options.companion);
    default: {
      const info = getProvider(provider);
      if (!info) throw new TypeError(`Unknown provider id: ${String(provider).slice(0, 40)}`);
      return createOpenAiChatAdapter({ provider, quirks: getQuirks(info.quirks) });
    }
  }
}

/**
 * Registers the built-in adapter of every provider; returns a function that removes them again.
 * @param {BuiltInOptions} [options]
 * @param {(id: ProviderId, adapter: Adapter) => () => void} [register]
 */
export function registerBuiltInAdapters(options = {}, register = registerAdapter) {
  const removers = PROVIDER_ORDER.map((id) => register(id, createAdapter(id, options)));
  return () => {
    for (const remove of removers) remove();
  };
}
