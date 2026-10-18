// Attachments of a chat message (src/js/chat/attachments.js): what a file is, the size an image is
// scaled to, the text budget per model, and how files are prepared on this device.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS } from '../../src/js/config.js';
import { ATTACH_ACCEPT, blobToBase64, fitSize, kindOf, needsVision, prepareAttachment, textBudget } from '../../src/js/chat/attachments.js';

describe('attachments', () => {
  it('tell images, PDFs, documents and text apart, by type and by name', () => {
    assert.equal(kindOf({ name: 'a.png', type: 'image/png' }), 'image');
    assert.equal(kindOf({ name: 'photo.JPG', type: '' }), 'image');
    assert.equal(kindOf({ name: 'a.webp', type: 'image/webp' }), 'image');
    assert.equal(kindOf({ name: 'x.svg', type: 'image/svg+xml' }), null, 'SVG is not sent as an image');
    assert.equal(kindOf({ name: 'report.pdf', type: '' }), 'pdf');
    assert.equal(kindOf({ name: 'deck.pptx', type: '' }), 'document');
    assert.equal(kindOf({ name: 'page.html', type: 'text/html' }), 'document');
    assert.equal(kindOf({ name: 'main.rs', type: '' }), 'text');
    assert.equal(kindOf({ name: 'data.json', type: 'application/json' }), 'text');
    assert.equal(kindOf({ name: 'notes', type: 'text/plain' }), 'text');
    assert.equal(kindOf({ name: 'tool.exe', type: 'application/octet-stream' }), null);
    for (const ext of ['.pdf', '.docx', '.md', '.py', 'image/png']) assert.ok(ATTACH_ACCEPT.includes(ext), ext);
  });

  it('scale images to the long edge and keep small ones as they are', () => {
    assert.equal(LIMITS.imageLongEdge, 1568);
    assert.deepEqual(fitSize(3000, 2000), { width: 1568, height: 1045, scaled: true });
    assert.deepEqual(fitSize(1000, 4000), { width: 392, height: 1568, scaled: true });
    assert.deepEqual(fitSize(1568, 800), { width: 1568, height: 800, scaled: false });
    assert.deepEqual(fitSize(100, 100, 50), { width: 50, height: 50, scaled: true });
  });

  it('give each model a text budget that follows its context', () => {
    assert.equal(textBudget(null), LIMITS.freeAttachmentChars);
    assert.equal(textBudget({ contextTokens: 4096 }), Math.floor((4096 * 3.5) / 5));
    assert.equal(textBudget({ contextTokens: 1000 }), 2000);
    assert.equal(textBudget({ contextTokens: 1_000_000 }), LIMITS.attachmentTextChars);
    assert.equal(LIMITS.attachmentsPerMessage, 10);
  });

  it('need a model that sees only for images', () => {
    assert.equal(needsVision([{ kind: 'pdf' }, { kind: 'text' }]), false);
    assert.equal(needsVision([{ kind: 'pdf' }, { kind: 'image' }]), true);
  });

  it('read text files at once and keep PDFs and documents for later', async () => {
    const text = await prepareAttachment(new File(['print("hi")'], 'hello.py', { type: 'text/x-python' }));
    assert.equal(text.kind, 'text');
    assert.equal(text.text, 'print("hi")');
    const pdf = await prepareAttachment(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }));
    assert.equal(pdf.kind, 'pdf');
    assert.equal(pdf.mime, 'application/pdf');
    assert.equal(pdf.text, undefined);
    await assert.rejects(prepareAttachment(new File(['x'], 'tool.exe')), (err) => /** @type {any} */ (err).code === 'unsupported_type');
    assert.equal(await blobToBase64(new Blob(['hi'])), 'aGk=');
  });
});
