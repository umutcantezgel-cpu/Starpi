// Generated images: the OpenAI and xAI Images API and a Gemini image model against their fakes,
// image events to blobs of the chat store, the image tool, and blob: images under an answer.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { TINY_PNG_BASE64 } from '../../scripts/fakes/shared.mjs';
import { createAdapter } from '../../src/js/ai/adapters/index.js';
import { complete as completeCall } from '../../src/js/ai/index.js';
import { directTransport } from '../../src/js/ai/transport.js';
import { base64Blob, generateImage, imageModelFor, imageProvider, imageTool, keepImages, showGeneratedImages, sniffImage, storeGeneratedImages } from '../../src/js/chat/image-view.js';

const openai = createOpenAiFake({ gapMs: 0 });
const gemini = createGeminiFake({ gapMs: 0 });
let openaiUrl = '';
let geminiUrl = '';
before(async () => {
  openaiUrl = (await openai.listen(0)).url;
  geminiUrl = (await gemini.listen(0)).url;
});
after(async () => {
  await openai.close();
  await gemini.close();
});

describe('making images', () => {
  it('OpenAI: the Images API answers with base64, no response_format for gpt-image models', async () => {
    const images = await generateImage({ provider: 'openai', prompt: 'A lighthouse at dusk', size: '1024x1024', transport: directTransport(openaiUrl, 'sk-test', undefined, { provider: 'openai' }) });
    assert.deepEqual(images, [{ mime: 'image/png', data: TINY_PNG_BASE64 }]);
    const sent = openai.requests.at(-1);
    assert.equal(sent?.path, '/v1/images/generations');
    assert.deepEqual(sent?.body, { model: 'gpt-image-1', prompt: 'A lighthouse at dusk', n: 1, size: '1024x1024' });
    assert.equal(sent?.headers.authorization, 'Bearer sk-test');
  });

  it('xAI: the same API, asking for base64', async () => {
    await generateImage({ provider: 'xai', prompt: 'A red kite', transport: directTransport(`${openaiUrl}/flavor/xai`, 'xai-test', undefined, { provider: 'xai' }) });
    assert.deepEqual(openai.requests.at(-1)?.body, { model: 'grok-2-image', prompt: 'A red kite', n: 1, response_format: 'b64_json' });
  });

  it('Gemini: the image model\'s image events become images', async () => {
    /** @type {typeof completeCall} */
    const complete = (req, opts) => completeCall(req, { ...opts, adapter: createAdapter('gemini'), transport: directTransport(geminiUrl, 'g-test', undefined, { provider: 'gemini' }) });
    const images = await generateImage({ provider: 'gemini', prompt: 'A small test picture', complete });
    assert.deepEqual(images, [{ mime: 'image/png', data: TINY_PNG_BASE64 }]);
    assert.equal(imageModelFor('gemini'), 'gemini-2.5-flash-image');
    const body = gemini.requests.at(-1)?.body;
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  });

  it('reports failures as AiErrors and needs a prompt', async () => {
    await assert.rejects(generateImage({ provider: 'openai', prompt: ' ' }), (/** @type {any} */ err) => err.code === 'bad_request');
    await assert.rejects(generateImage({ provider: 'openai', prompt: 'x [[fake-fault:429]]', transport: directTransport(openaiUrl, 'sk', undefined, { provider: 'openai', fetch: (u, init) => globalThis.fetch(u, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-fake-fault': '429' } }) }) }), (/** @type {any} */ err) => err.code === 'rate_limited');
    await assert.rejects(generateImage({ provider: /** @type {any} */ ('groq'), prompt: 'x' }), (/** @type {any} */ err) => err.code === 'bad_request');
  });

  it('picks the provider of the user\'s own key, never a pool', () => {
    assert.equal(imageProvider(() => ''), null);
    assert.equal(imageProvider((slot) => (slot === 'xai' ? 'k' : '')), 'xai');
    assert.equal(imageProvider(() => 'k'), 'openai');
  });
});

describe('keeping images', () => {
  it('keeps only real images, typed by their bytes', () => {
    assert.equal(sniffImage(TINY_PNG_BASE64), 'image/png');
    assert.equal(sniffImage('/9j/4AAQ'), 'image/jpeg');
    assert.equal(sniffImage('PHN2Zz4='), null);
    assert.deepEqual(keepImages([{ mime: 'image/svg+xml', data: 'PHN2Zz4=' }, { mime: 'image/png', data: 'not base64!' }, { mime: 'text/html', data: TINY_PNG_BASE64 }]), [{ mime: 'image/png', data: TINY_PNG_BASE64 }]);
  });

  it('turns image events into blobs owned by the answer', async () => {
    /** @type {Array<{ blob: Blob, opts: any }>} */
    const stored = [];
    const parts = await storeGeneratedImages([{ mime: 'image/png', data: TINY_PNG_BASE64 }], async (blob, opts) => (stored.push({ blob, opts }), `blob-${stored.length}`), 'answer-1');
    assert.deepEqual(parts, [{ type: 'image', mime: 'image/png', blobId: 'blob-1', name: 'image-1.png', generated: true }]);
    assert.equal(stored[0].blob.type, 'image/png');
    assert.equal(stored[0].blob.size, Buffer.from(TINY_PNG_BASE64, 'base64').length);
    assert.deepEqual(stored[0].opts, { kind: 'attachment', name: 'image-1.png', ownerId: 'answer-1' });
    const bytes = new Uint8Array(await base64Blob(TINY_PNG_BASE64, 'image/png').arrayBuffer());
    assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
  });

  it('shows the images of an answer as blob: images with a download button', async (t) => {
    const dom = new JSDOM('<div class="message-row"><div class="message-content">Here.</div></div>');
    // The icon renderer creates its SVG through the global document.
    const g = /** @type {any} */ (globalThis);
    const before = g.document;
    g.document = dom.window.document;
    t.after(() => {
      g.document = before;
    });
    const el = /** @type {HTMLElement} */ (dom.window.document.querySelector('.message-row'));
    const node = { role: 'assistant', parts: [{ type: 'text', text: 'Here.' }, { type: 'image', mime: 'image/png', blobId: 'b1', name: 'image-1.png', generated: true }, { type: 'image', blobId: 'b2' }] };
    await showGeneratedImages(el, /** @type {any} */ (node), async (id) => (id === 'b1' ? { data: base64Blob(TINY_PNG_BASE64, 'image/png') } : undefined));
    const imgs = el.querySelectorAll('.generated-images img');
    assert.equal(imgs.length, 1);
    assert.match(String(imgs[0].getAttribute('src')), /^blob:/);
    assert.equal(imgs[0].getAttribute('alt'), 'Generated image');
    assert.ok(el.querySelector('.generated-image button'));
    // Once per answer; never for a question.
    await showGeneratedImages(el, /** @type {any} */ (node), async () => ({ data: base64Blob(TINY_PNG_BASE64, 'image/png') }));
    assert.equal(el.querySelectorAll('.generated-images').length, 1);
    const q = dom.window.document.createElement('div');
    await showGeneratedImages(q, /** @type {any} */ ({ ...node, role: 'user' }), async () => undefined);
    assert.equal(q.children.length, 0);
  });
});

describe('image tool', () => {
  it('asks first (class low), makes the image and hands it on without sending it to the model', async () => {
    const tool = imageTool({ provider: () => 'openai', generate: async (o) => (assert.equal(o.prompt, 'A fox'), [{ mime: 'image/png', data: TINY_PNG_BASE64 }]) });
    assert.equal(tool.effect, 'low');
    const out = await tool.run({ prompt: 'A fox' }, { signal: new AbortController().signal, locale: 'en' });
    assert.deepEqual(out.images, [{ mime: 'image/png', data: TINY_PNG_BASE64 }]);
    assert.doesNotMatch(out.content, /iVBOR/);
    const none = await imageTool({ provider: () => null }).run({ prompt: 'x' }, { signal: new AbortController().signal, locale: 'en' });
    assert.equal(none.isError, true);
  });
});
