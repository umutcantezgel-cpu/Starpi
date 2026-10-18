// @ts-check
// Files and images attached to a chat message: what they are, how they are prepared on this device,
// and the content parts they become for a model.
//
// - Up to LIMITS.attachmentsPerMessage per message.
// - Images (JPEG, PNG, WebP, GIF) are drawn onto a canvas at most LIMITS.imageLongEdge pixels on
//   the long edge and stored as JPEG at LIMITS.imageQuality, which keeps a request with several of
//   them small (the relay and the pools take a few MB at most). An image that is already small
//   enough and a JPEG stays as it is.
// - PDFs go to models that read them (caps.pdf) as they are, while they are small enough; for every
//   other model, and in source mode, their text is extracted on this device (rag/parser.js).
// - Text, Markdown, CSV, JSON, code and office documents become text, fenced as a file
//   (prompts.js attachmentSection), within a budget that follows the model's context.
// Nothing here leaves the device; the thread decides what is sent where.
import { LIMITS } from '../config.js';

/** @typedef {import('../ai/contract.js').Part} Part */
/** @typedef {import('../ai/contract.js').Caps} Caps */
/** @typedef {'image' | 'pdf' | 'text' | 'document'} AttachmentKind */

/**
 * An attachment once it is ready to send.
 * @typedef {object} PreparedAttachment
 * @property {string} id
 * @property {string} name
 * @property {AttachmentKind} kind
 * @property {string} mime        of `blob`
 * @property {Blob} blob          what is stored and sent (the scaled JPEG of an image)
 * @property {File} file          the file as the user gave it (source mode adds it to the workspace)
 * @property {number} [width]     of the scaled image
 * @property {number} [height]
 * @property {string} [text]      the text of a text file (documents and PDFs: extracted on demand)
 */

export const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;
const PDF_EXT = /\.pdf$/i;
/** Read as plain text: prose, data and source code. */
const TEXT_EXT = /\.(?:txt|md|markdown|csv|tsv|json|log|xml|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|swift|sh|bash|zsh|sql|r|lua|pl|scala|dart|css|scss|less|vue|svelte|tex)$/i;
/** Parsed by rag/parser.js. */
const DOCUMENT_EXT = /\.(?:docx|xlsx|pptx|html?)$/i;
/** PDFs larger than this go as text even to models that read PDFs (request size). */
export const MAX_NATIVE_PDF_BYTES = 3 * 1024 * 1024;
/** Largest text file read as a whole. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** The accept attribute of the attach picker. */
export const ATTACH_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,.pdf,.docx,.xlsx,.pptx,.html,.htm,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.js,.mjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.hpp,.cs,.php,.swift,.sh,.sql,.css,.scss,.vue,.svelte,.tex';

/**
 * What a file is, by its type and name; null for files the chat cannot use.
 * @param {{ name: string, type?: string }} file
 * @returns {AttachmentKind | null}
 */
export function kindOf(file) {
  const type = (file.type || '').toLowerCase();
  if (IMAGE_TYPES.includes(type) || (!type && IMAGE_EXT.test(file.name))) return 'image';
  if (type === 'application/pdf' || PDF_EXT.test(file.name)) return 'pdf';
  if (DOCUMENT_EXT.test(file.name)) return 'document';
  if (TEXT_EXT.test(file.name) || type.startsWith('text/') || type === 'application/json') return 'text';
  return null;
}

/**
 * The size an image is drawn at: its own when the long edge fits, else scaled down to it.
 * @param {number} width
 * @param {number} height
 * @param {number} [longEdge]
 * @returns {{ width: number, height: number, scaled: boolean }}
 */
export function fitSize(width, height, longEdge = LIMITS.imageLongEdge) {
  const long = Math.max(width, height);
  if (!(long > longEdge)) return { width, height, scaled: false };
  const f = longEdge / long;
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)), scaled: true };
}

/**
 * An image as JPEG with its long edge at most LIMITS.imageLongEdge. A small JPEG stays as it is.
 * @param {Blob} blob
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function downscaleImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const size = fitSize(bitmap.width, bitmap.height);
    if (!size.scaled && blob.type === 'image/jpeg') return { blob, width: size.width, height: size.height };
    /** @type {OffscreenCanvas | HTMLCanvasElement} */
    let canvas;
    if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(size.width, size.height);
    else {
      canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const ctx = /** @type {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null} */ (canvas.getContext('2d'));
    if (!ctx) throw new Error('No 2D canvas');
    // JPEG has no transparency: transparent pixels become white, not black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const out =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: LIMITS.imageQuality })
        : await new Promise((resolve, reject) => /** @type {HTMLCanvasElement} */ (canvas).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', LIMITS.imageQuality));
    return { blob: /** @type {Blob} */ (out), width: size.width, height: size.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Base64 of a blob, without a data: prefix.
 * @param {Blob} blob
 */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/**
 * Prepares one file: images scaled, text read; PDFs and documents are kept as they are and read
 * when a model needs their text. Throws an Error whose `code` names the problem
 * (unsupported_type, too_large, unreadable).
 * @param {File} file
 * @returns {Promise<PreparedAttachment>}
 */
export async function prepareAttachment(file) {
  const kind = kindOf(file);
  const fail = (/** @type {string} */ code) => Object.assign(new Error(code), { code });
  if (!kind) throw fail('unsupported_type');
  const id = crypto.randomUUID();
  if (kind === 'image') {
    try {
      const scaled = await downscaleImage(file);
      return { id, name: file.name, kind, mime: scaled.blob.type || 'image/jpeg', blob: scaled.blob, file, width: scaled.width, height: scaled.height };
    } catch {
      throw fail('unreadable');
    }
  }
  if (kind === 'text') {
    if (file.size > MAX_TEXT_BYTES) throw fail('too_large');
    return { id, name: file.name, kind, mime: 'text/plain', blob: file, file, text: await file.text() };
  }
  return { id, name: file.name, kind, mime: kind === 'pdf' ? 'application/pdf' : file.type || 'application/octet-stream', blob: file, file };
}

/**
 * The text of a PDF or document, extracted on this device (and kept with the attachment).
 * @param {PreparedAttachment} att
 * @returns {Promise<string>}
 */
export async function attachmentText(att) {
  if (typeof att.text === 'string') return att.text;
  const { extractText } = await import('../rag/parser.js');
  const named = Object.assign(att.blob, { name: att.name });
  att.text = (await extractText(/** @type {Blob & { name: string }} */ (named))).text;
  return att.text;
}

/**
 * Whether a list of attachments needs a model that sees images.
 * @param {readonly { kind: AttachmentKind | string }[]} list
 */
export function needsVision(list) {
  return list.some((a) => a.kind === 'image');
}

/**
 * The characters of attached text one model gets in all: a fifth of its context (at least 2,000),
 * at most LIMITS.attachmentTextChars; LIMITS.freeAttachmentChars when the context is not known.
 * @param {Pick<Caps, 'contextTokens'> | null} caps
 */
export function textBudget(caps) {
  if (!caps?.contextTokens) return LIMITS.freeAttachmentChars;
  const fifth = Math.floor((caps.contextTokens * 3.5) / 5);
  return Math.min(LIMITS.attachmentTextChars, Math.max(2_000, fifth));
}
