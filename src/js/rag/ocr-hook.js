// @ts-check
// Text recognition for images added to the workspace, through the AI layer's `ocr_image` purpose
// (a vision model the user set up). The ingest worker asks for it only for a file the user agreed
// to have read (workspace.js passes the hook with that one file), and the image goes to the model,
// nothing else. The AI layer loads on first use, so the app's first load stays small.
import { IMAGE_EXTENSIONS, OCR_PURPOSE } from './formats/image.js';

/** @typedef {import('./workspace-core.js').WorkspaceOcrHook} WorkspaceOcrHook */

/** Extensions the pickers accept once text recognition is available. */
export const OCR_ACCEPT = [...IMAGE_EXTENSIONS].map((ext) => `.${ext}`).join(',');

/**
 * Whether a model that can read images is set up (the purpose has at least one step to run).
 * @returns {Promise<boolean>}
 */
export async function ocrAvailable() {
  try {
    const [{ planChain, routerDeps }, { getPurpose }] = await Promise.all([import('../ai/router.js'), import('../ai/purposes.js')]);
    const def = getPurpose(OCR_PURPOSE);
    return Boolean(def) && planChain(/** @type {any} */ (def), {}, routerDeps()).length > 0;
  } catch {
    return false;
  }
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/**
 * The OCR hook for one consented image: the recognised text with the provider and model that read
 * it (receipts record them), or an error when no model answered.
 * @returns {WorkspaceOcrHook}
 */
export function ocrHook() {
  return async (request) => {
    const { runPurpose } = await import('../ai/router.js');
    const result = await runPurpose(OCR_PURPOSE, { image: { mime: request.mime, data: base64(request.bytes) } }, { cache: 'off' });
    if (!result.ok || typeof result.text !== 'string') throw new Error(result.fallbackReason ?? 'No model could read the image');
    return { text: result.text, provider: result.provider, model: result.model };
  };
}
