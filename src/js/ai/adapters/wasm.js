// @ts-check
// Adapter for the processor runtime (Transformers.js in a worker, src/js/wasm/client.js): small
// models on the CPU when WebGPU is missing. Pass the WasmEngineClient as `engine` to stream its
// chunks directly; without it the adapter goes through the engine controller of webgpu/engine.js,
// which loads processor presets (`wasm:<key>`) into the same client. See on-device.js for the
// shared mechanics.
import { createOnDeviceAdapter } from './on-device.js';

/** @typedef {import('./on-device.js').OnDeviceOptions} OnDeviceOptions */

/**
 * @param {OnDeviceOptions} [options]
 */
export function createWasmAdapter(options = {}) {
  return createOnDeviceAdapter('wasm', 'wasm', options);
}

export const wasmAdapter = createWasmAdapter();
