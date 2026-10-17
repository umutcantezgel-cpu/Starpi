// @ts-check
// Adapter for the WebGPU engine (WebLLM): the conversation runs on the user's GPU. By default it
// streams through the engine controller of webgpu/engine.js, which holds the loaded model; a
// WebLLM engine object can be passed instead. Model ids are the picker's preset references
// (`webgpu:<key>`), or 'auto' for whatever model is loaded. Reasoning written as <think> tags
// arrives as reasoning events. See on-device.js for the shared mechanics.
import { createOnDeviceAdapter } from './on-device.js';

/** @typedef {import('./on-device.js').OnDeviceOptions} OnDeviceOptions */

/**
 * @param {OnDeviceOptions} [options]
 */
export function createWebllmAdapter(options = {}) {
  return createOnDeviceAdapter('webgpu', 'webllm', options);
}

export const webllmAdapter = createWebllmAdapter();
