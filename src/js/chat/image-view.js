// @ts-check
/**
 * @file Generated images in the chat: making them, keeping them and showing them.
 *
 * - Making: OpenAI and xAI through their Images API (POST /v1/images/generations), Gemini through
 *   an image model whose answer carries inline images (the Gemini adapter turns them into `image`
 *   events). Only with the user's own key: the site's pools never make images.
 * - The chat offers it as the `generate_image` tool (side-effect class "low", and every image costs
 *   money, so each call asks first and "Always allow" is not offered, approval.js), and an answer
 *   that carries `image` events keeps them too.
 * - Keeping: each image becomes a blob of the chat store, owned by its answer, and an image part
 *   of that answer ({ type: 'image', mime, blobId, name, generated: true }).
 * - Showing: the parts are shown below the answer as blob: images (the CSP allows img-src blob:),
 *   each with a download button.
 */
import { capsFor, snapshotModels } from '../ai/catalog/models.js';
import { complete as completeCall } from '../ai/index.js';
import { getKey } from '../ai/keys.js';
import { selectTransport } from '../ai/transport-select.js';
import { readText } from '../ai/sse.js';
import { AiError, fromHttp } from '../ai/errors.js';
import { setText, t } from '../i18n/index.js';
import { refreshIcons } from '../icons.js';

/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('../ai/transport.js').Transport} Transport */
/** @typedef {import('../ai/tools/registry.js').ToolDef} ToolDef */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */

/** @typedef {{ mime: string, data: string }} GeneratedImage */

/** Providers that make images, in the order the tool picks one. */
export const IMAGE_PROVIDERS = /** @type {readonly ProviderId[]} */ (Object.freeze(['openai', 'gemini', 'xai']));
/** The image model of a provider when its catalog names none. */
export const DEFAULT_IMAGE_MODELS = Object.freeze(/** @type {Record<string, string>} */ ({ openai: 'gpt-image-1', gemini: 'gemini-2.5-flash-image', xai: 'grok-2-image' }));
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Largest generated image kept (decoded bytes). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
/** The file name of a download whose part has none. */
const FALLBACK_NAME = 'image.png';

/**
 * The image model of a provider: the first model of its catalog that makes images, else the default.
 * @param {ProviderId} provider
 */
export function imageModelFor(provider) {
  return snapshotModels(provider).find((m) => m.caps.imageOut)?.id ?? DEFAULT_IMAGE_MODELS[provider] ?? null;
}

/**
 * The provider that makes images for the user: the first one of IMAGE_PROVIDERS with the user's own
 * key (pools never do). Null when there is none.
 * @param {(slot: string) => string} [keyOf]
 * @returns {ProviderId | null}
 */
export function imageProvider(keyOf = getKey) {
  return IMAGE_PROVIDERS.find((p) => Boolean(keyOf(p))) ?? null;
}

/**
 * The type of an image from its first bytes (base64): PNG, JPEG, WebP or GIF; null for anything else.
 * @param {string} data
 */
export function sniffImage(data) {
  if (data.startsWith('iVBORw0KGgo')) return 'image/png';
  if (data.startsWith('/9j/')) return 'image/jpeg';
  if (data.startsWith('UklGR')) return 'image/webp';
  if (data.startsWith('R0lGOD')) return 'image/gif';
  return null;
}

/**
 * @typedef {object} GenerateOptions
 * @property {ProviderId} provider
 * @property {string} prompt
 * @property {string} [model]
 * @property {string} [size]
 * @property {AbortSignal} [signal]
 * @property {Transport} [transport]          OpenAI and xAI: replaces the transport selection (tests)
 * @property {typeof completeCall} [complete]  Gemini: replaces the AI layer's call (tests)
 */

/**
 * Makes images from a prompt. Throws an AiError when the provider cannot make one (no key, a
 * refused prompt, a failed call).
 * @param {GenerateOptions} opts
 * @returns {Promise<GeneratedImage[]>}
 */
export async function generateImage(opts) {
  const { provider } = opts;
  const prompt = String(opts.prompt ?? '').trim().slice(0, 4000);
  if (!prompt) throw new AiError('bad_request', { provider });
  const model = opts.model ?? imageModelFor(provider);
  if (!model || !IMAGE_PROVIDERS.includes(provider)) throw new AiError('bad_request', { provider });
  if (provider === 'gemini') {
    const call = (opts.complete ?? completeCall)({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }, { signal: opts.signal });
    const result = await call.result;
    if (result.error) throw result.error;
    const images = keepImages(result.images);
    if (!images.length) throw new AiError(result.stopReason === 'refusal' ? 'refusal' : 'bad_response', { provider });
    return images;
  }
  const transport = opts.transport ?? /** @type {Transport | null} */ (selectTransport(provider, { key: getKey(provider), pool: false }));
  if (!transport) throw new AiError('auth', { provider });
  const size = opts.size && IMAGE_SIZES.includes(opts.size) ? opts.size : undefined;
  // gpt-image models always answer with base64 and refuse response_format; the others need it.
  const body = { model, prompt, n: 1, ...(size && provider === 'openai' ? { size } : {}), ...(/^gpt-image/.test(model) ? {} : { response_format: 'b64_json' }) };
  const res = await transport(null, { path: '/v1/images/generations', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body }, { signal: opts.signal });
  const text = await readText(res.body, { maxBytes: MAX_RESPONSE_BYTES, truncate: !res.ok });
  if (!res.ok) throw fromHttp(res.status, res.headers, text.slice(0, 512), { provider });
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new AiError('bad_response', { provider, cause: err });
  }
  const list = Array.isArray(json?.data) ? json.data : [];
  const images = keepImages(list.map((/** @type {any} */ d) => ({ mime: '', data: typeof d?.b64_json === 'string' ? d.b64_json : '' })));
  if (!images.length) throw new AiError('bad_response', { provider });
  return images;
}

/**
 * The images worth keeping: base64 of a known image type (the type is read from the bytes, not
 * taken from the provider), not too large, at most MAX_IMAGES.
 * @param {readonly GeneratedImage[]} images
 * @returns {GeneratedImage[]}
 */
export function keepImages(images) {
  /** @type {GeneratedImage[]} */
  const out = [];
  for (const img of images) {
    if (out.length >= MAX_IMAGES) break;
    const data = typeof img?.data === 'string' ? img.data.replace(/\s+/g, '') : '';
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length * 0.75 > MAX_IMAGE_BYTES) continue;
    const mime = sniffImage(data);
    if (mime && IMAGE_MIMES.has(mime)) out.push({ mime, data });
  }
  return out;
}

/**
 * Base64 as a Blob of the given type.
 * @param {string} data
 * @param {string} mime
 */
export function base64Blob(data, mime) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Stores generated images as blobs owned by an answer and returns the answer's image parts.
 * @param {readonly GeneratedImage[]} images
 * @param {(blob: Blob, opts: { kind: 'attachment', name: string, ownerId: string }) => Promise<string>} putBlob
 * @param {string} ownerId  the answer's node id
 * @returns {Promise<Array<{ type: 'image', mime: string, blobId: string, name: string, generated: true }>>}
 */
export async function storeGeneratedImages(images, putBlob, ownerId) {
  const parts = [];
  for (const [i, img] of keepImages(images).entries()) {
    const ext = img.mime.split('/')[1].replace('jpeg', 'jpg');
    const name = `image-${i + 1}.${ext}`;
    const blobId = await putBlob(base64Blob(img.data, img.mime), { kind: 'attachment', name, ownerId });
    parts.push({ type: /** @type {const} */ ('image'), mime: img.mime, blobId, name, generated: /** @type {const} */ (true) });
  }
  return parts;
}

/**
 * Shows the generated images of an answer below its text (once per answer element).
 * @param {HTMLElement} el  the answer's message row
 * @param {Pick<NodeRecord, 'role' | 'parts'>} node
 * @param {(id: string) => Promise<{ data: Blob } | undefined>} getBlob
 */
export async function showGeneratedImages(el, node, getBlob) {
  if (node.role !== 'assistant') return;
  const parts = node.parts.filter((p) => p.type === 'image' && p.generated === true && typeof p.blobId === 'string');
  if (!parts.length || el.querySelector('.generated-images')) return;
  const box = el.ownerDocument.createElement('div');
  box.className = 'generated-images mt-2 flex flex-wrap gap-2';
  el.querySelector('.message-content')?.after(box);
  for (const part of parts) {
    const record = await getBlob(String(part.blobId)).catch(() => undefined);
    if (!record?.data) continue;
    const figure = el.ownerDocument.createElement('figure');
    figure.className = 'generated-image relative max-w-full';
    const img = el.ownerDocument.createElement('img');
    const url = URL.createObjectURL(record.data);
    img.src = url;
    img.className = 'max-h-96 max-w-full rounded-xl border border-slate-200';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = t('tools.image.alt');
    // The decoded picture stays on screen; the address is only needed until it has loaded.
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    const save = el.ownerDocument.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-ghost p-1 absolute top-1 right-1 bg-white/80';
    save.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i><span class="sr-only"></span>';
    setText(/** @type {HTMLElement} */ (save.querySelector('span')), 'tools.image.download');
    save.addEventListener('click', () => {
      const href = URL.createObjectURL(record.data);
      const a = el.ownerDocument.createElement('a');
      a.href = href;
      a.download = String(part.name ?? FALLBACK_NAME);
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    });
    figure.append(img, save);
    box.append(figure);
  }
  refreshIcons(box);
}

/**
 * The image tool for the chat's registry: makes an image with the user's image provider.
 * @param {{ provider: () => ProviderId | null, generate?: typeof generateImage }} deps
 * @returns {ToolDef}
 */
export function imageTool(deps) {
  const generate = deps.generate ?? generateImage;
  return {
    name: 'generate_image',
    origin: 'builtin',
    labelKey: 'tools.builtin.generate_image',
    effect: 'low',
    askEachTime: true,
    description: 'Creates an image from a detailed description and shows it to the user. Use it only when the user asks for an image.',
    schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'What the image shows, in detail', maxLength: 4000 }, size: { type: 'string', enum: [...IMAGE_SIZES] } },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const provider = deps.provider();
      if (!provider) return { content: JSON.stringify({ error: 'no image provider is set up' }), isError: true };
      try {
        const images = await generate({ provider, prompt: String(args.prompt), size: typeof args.size === 'string' ? args.size : undefined, signal: ctx.signal });
        return { content: JSON.stringify({ created: images.length, note: 'The image is shown to the user. Do not describe it as if you could see it.' }), images };
      } catch (err) {
        const code = err instanceof AiError ? err.code : 'bad_response';
        return { content: JSON.stringify({ error: `the image could not be made (${code})` }), isError: true };
      }
    },
  };
}

/**
 * Whether a model makes images itself (its answers carry image events).
 * @param {ProviderId} provider
 * @param {string} model
 */
export function makesImages(provider, model) {
  return capsFor(provider, model).imageOut;
}
