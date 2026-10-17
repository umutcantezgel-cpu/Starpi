// The persistent workspace (src/js/rag/workspace-core.js, run by the ingest worker): documents,
// chunks, vectors and original bytes survive a restart in the app database (fake-indexeddb here,
// files in the database's blob store), the BM25 index is rebuilt from the stored chunks, "memory
// only" and "Forget all" remove what was kept, and receipts verify against the stored originals.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReceipt, sha256Hex } from '../../src/js/core/receipt.js';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { createFileStore } from '../../src/js/store/opfs.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { createWorkspace, KEEP_SETTING, WORKSPACE_FILES_DIR } from '../../src/js/rag/workspace-core.js';

let seq = 0;
const dbName = () => `ws-persist-${(seq += 1)}`;

const PLAN = [
  '# Launch plan',
  '',
  'The public launch is planned for 12 May 2027 in the Hamburg depot.',
  '',
  'The approved budget is 480,000 EUR, owned by the finance lead.',
  '',
  'Weekly reviews take place every Tuesday at 10:00 in room 4.',
].join('\n');
const NOTES = 'Meeting notes: the cafeteria menu changes every Monday. Remote work is allowed two days per week.';

/** @param {string} text @param {string} name */
const file = (text, name) => new File([text], name, { type: 'text/markdown' });

/**
 * A workspace on a named database, as a fresh worker would open it.
 * @param {string} name
 * @param {{ factory?: IDBFactory | null }} [options]
 */
function open(name, options = {}) {
  return createWorkspace({ openDb: () => openAppDb({ name, ...options }), fileRoot: null });
}

const MODEL = { id: 'test/model@abc/q8', dim: 4 };
/** A deterministic 4-dimensional "embedding": counts of a few topic words. */
function fakeEmbed(/** @type {string} */ text) {
  const t = text.toLowerCase();
  const v = Float32Array.from([/budget|eur|finance/g, /launch|may/g, /tuesday|review/g, /menu|cafeteria|remote/g].map((re) => (t.match(re) ?? []).length + 0.01));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

describe('persistent workspace', () => {
  it('restores documents, chunks and the BM25 index after a restart', async () => {
    const name = dbName();
    const first = open(name);
    const state = await first.init();
    assert.equal(state.persistent, true);
    assert.equal(state.keep, null);
    const doc = await first.ingest(file(PLAN, 'plan.md'), { chunkSize: 80, chunkOverlap: 10 });
    assert.equal(doc.stored, true);
    assert.ok(doc.chunks > 2);
    const before = first.search('budget finance', 3);
    assert.equal(before[0].docName, 'plan.md');

    const second = open(name);
    const restored = await second.init();
    assert.deepEqual(
      restored.documents.map((d) => ({ docId: d.docId, name: d.name, chunks: d.chunks, fileSha256: d.fileSha256, textSha256: d.textSha256, stored: d.stored })),
      [{ docId: doc.docId, name: 'plan.md', chunks: doc.chunks, fileSha256: doc.fileSha256, textSha256: doc.textSha256, stored: true }],
    );
    assert.equal(restored.chunks, doc.chunks);
    assert.deepEqual(second.search('budget finance', 3), before);
    // The extracted text comes back from the file store, offsets and all.
    const { text } = await second.text(doc.docId);
    assert.equal(text, PLAN);
    assert.equal(await sha256Hex(text), doc.textSha256);
    const hit = before[0];
    const ctx = await second.context(hit.docId, hit.start, hit.end, 20);
    assert.equal(ctx.match, hit.text);
    assert.equal(PLAN.slice(hit.start, hit.end), hit.text);
    // New documents of the restarted workspace get ids no earlier document had.
    const more = await second.ingest(file(NOTES, 'notes.md'));
    assert.notEqual(more.docId, doc.docId);
    assert.equal((await open(name).init()).documents.length, 2);
  });

  it('keeps vectors per model and searches them after a restart', async () => {
    const name = dbName();
    const first = open(name);
    await first.init({ model: MODEL });
    await first.ingest(file(PLAN, 'plan.md'), { chunkSize: 80, chunkOverlap: 10 });
    await first.ingest(file(NOTES, 'notes.md'));
    const pending = first.pendingVectors(100);
    assert.equal(pending.length, first.state().chunks);
    const put = await first.putVectors(MODEL.id, pending.map((c) => ({ docId: c.docId, idx: c.idx, vector: fakeEmbed(c.text) })));
    assert.equal(put.added, pending.length);
    assert.deepEqual(first.pendingVectors(100), []);
    // Vectors of another model or of the wrong length are refused.
    assert.equal((await first.putVectors('other@1/q8', [{ docId: pending[0].docId, idx: 0, vector: fakeEmbed('x') }])).added, 0);
    assert.equal((await first.putVectors(MODEL.id, [{ docId: pending[0].docId, idx: 0, vector: [1, 0] }])).added, 0);

    const second = open(name);
    const state = await second.init({ model: MODEL });
    assert.equal(state.vectors, pending.length);
    assert.equal(state.model, MODEL.id);
    // "working from home" shares no word with the notes, its vector does.
    const query = 'working from home rules';
    assert.deepEqual(second.search(query, 3), []);
    const hits = second.searchHybrid(query, fakeEmbed('remote'), 3);
    assert.equal(hits[0].docName, 'notes.md');
    assert.equal(hits[0].keywordScore, null);
    assert.ok((hits[0].similarity ?? 0) > 0.9);
    // Without a vector, or with one of the wrong length, hybrid search is keyword search.
    assert.deepEqual(second.searchHybrid('budget', null, 3), second.search('budget', 3));
    assert.deepEqual(second.searchHybrid('budget', [1, 2], 3), second.search('budget', 3));

    // Another model: stored vectors of the old one are gone, every chunk is pending again.
    const switched = await second.setModel({ id: 'test/other@def/q8', dim: 4 });
    assert.equal(switched.vectors, 0);
    assert.equal(second.pendingVectors(100).length, pending.length);
    const third = open(name);
    assert.equal((await third.init({ model: MODEL })).vectors, 0);
  });

  it('stores nothing more after "memory only" and deletes what it kept', async () => {
    const name = dbName();
    const ws = open(name);
    await ws.init();
    await ws.ingest(file(PLAN, 'plan.md'));
    const answer = await ws.setKeep(false);
    assert.deepEqual(answer, { keep: false, stored: 0, persistent: true });
    assert.equal(ws.state().documents.length, 1, 'documents stay for this session');
    assert.equal(ws.state().documents[0].stored, false);
    const later = await ws.ingest(file(NOTES, 'notes.md'));
    assert.equal(later.stored, false);

    const db = await openAppDb({ name });
    assert.equal(await db.count('docs'), 0);
    assert.equal(await db.count('chunks'), 0);
    assert.deepEqual(await createFileStore({ db, dir: WORKSPACE_FILES_DIR, root: null }).list(), []);
    assert.equal((await db.get('settings', KEEP_SETTING)).value, false);
    const restarted = await open(name).init();
    assert.equal(restarted.keep, false);
    assert.deepEqual(restarted.documents, []);

    // Yes again: the documents in memory are stored now.
    const yes = await ws.setKeep(true);
    assert.equal(yes.stored, 2);
    assert.equal((await open(name).init()).documents.length, 2);
  });

  it('forgets everything on clear and a single document on remove', async () => {
    const name = dbName();
    const ws = open(name);
    await ws.init({ model: MODEL });
    const plan = await ws.ingest(file(PLAN, 'plan.md'));
    const notes = await ws.ingest(file(NOTES, 'notes.md'));
    await ws.putVectors(
      MODEL.id,
      ws.pendingVectors(100).map((c) => ({ docId: c.docId, idx: c.idx, vector: fakeEmbed(c.text) })),
    );
    const db = await openAppDb({ name });
    const files = createFileStore({ db, dir: WORKSPACE_FILES_DIR, root: null });
    assert.deepEqual(
      (await files.list()).map((f) => f.id).sort(),
      [notes.docId, `${notes.docId}.txt`, plan.docId, `${plan.docId}.txt`].sort(),
    );

    await ws.remove(plan.docId);
    assert.deepEqual(
      (await db.getAll('docs')).map((d) => d.id),
      [notes.docId],
    );
    assert.ok((await db.getAll('chunks')).every((c) => c.docId === notes.docId));
    assert.ok((await db.getAll('vectors')).every((v) => v.docId === notes.docId));
    assert.deepEqual(
      (await files.list()).map((f) => f.id).sort(),
      [notes.docId, `${notes.docId}.txt`].sort(),
    );

    assert.deepEqual(await ws.clear(), { cleared: true });
    assert.equal(await db.count('docs'), 0);
    assert.equal(await db.count('chunks'), 0);
    assert.equal(await db.count('vectors'), 0);
    assert.deepEqual(await files.list(), []);
    assert.deepEqual(ws.search('cafeteria', 3), []);
    assert.deepEqual((await open(name).init()).documents, []);
  });

  it('drops a stored document whose extracted text is gone', async () => {
    const name = dbName();
    const ws = open(name);
    await ws.init();
    const doc = await ws.ingest(file(PLAN, 'plan.md'));
    const db = await openAppDb({ name });
    await createFileStore({ db, dir: WORKSPACE_FILES_DIR, root: null }).delete(`${doc.docId}.txt`);
    assert.deepEqual((await open(name).init()).documents, []);
    assert.equal(await db.count('docs'), 0);
    assert.equal(await db.count('chunks'), 0);
  });

  it('keeps nothing when the database lives only in memory', async () => {
    const ws = open(dbName(), { factory: null });
    const state = await ws.init();
    assert.equal(state.persistent, false);
    const doc = await ws.ingest(file(PLAN, 'plan.md'));
    assert.equal(doc.stored, false);
    assert.equal(ws.search('budget', 1)[0].docId, doc.docId);
    assert.deepEqual(await ws.setKeep(true), { keep: null, stored: 0, persistent: false });
  });

  it('cancels an ingest that a clear overtook', async () => {
    const ws = open(dbName());
    await ws.init();
    const running = ws.ingest(file(PLAN, 'plan.md'));
    await ws.clear();
    await assert.rejects(running, (err) => /** @type {{ code?: string }} */ (err).code === 'cleared');
    assert.deepEqual(ws.state().documents, []);
  });

  it('reports a duplicate instead of indexing the same file twice', async () => {
    const name = dbName();
    const ws = open(name);
    await ws.init();
    const doc = await ws.ingest(file(PLAN, 'plan.md'));
    const again = await ws.ingest(file(PLAN, 'copy.md'));
    assert.equal(again.duplicate, true);
    assert.equal(again.docId, doc.docId);
    // After a restart too: the fingerprint is part of the stored record.
    const restarted = open(name);
    await restarted.init();
    assert.equal((await restarted.ingest(file(PLAN, 'plan.md'))).duplicate, true);
  });

  it('verifies a receipt against the original kept on this device', async () => {
    const name = dbName();
    const ws = open(name);
    await ws.init();
    const doc = await ws.ingest(file(PLAN, 'plan.md'));
    const [hit] = ws.search('budget', 1);
    const label = `[Doc: plan.md, Chunk: ${hit.chunkIndex + 1}]`;
    const answer = `The approved budget is 480,000 EUR ${label}.`;
    const sources = [{ label, doc: 'plan.md', heading: '', text: hit.text, delivered: /** @type {const} */ ('full') }];
    const receipt = await buildReceipt({
      createdAt: '2026-10-17T10:00:00.000Z',
      version: '3.0.0-test',
      answer: { text: answer, engine: 'cloud', locale: 'en' },
      question: 'What is the budget?',
      grounding: groundAnswer(blocksFromMarkdown(answer, sources), sources),
      citations: [
        {
          label,
          doc: 'plan.md',
          heading: '',
          source: 'workspace',
          delivered: 'full',
          text: hit.text,
          truncated: false,
          document: { name: doc.name, kind: doc.kind, bytes: doc.bytes, fileSha256: doc.fileSha256, textSha256: doc.textSha256, textChars: doc.chars, pages: doc.pages, extractor: doc.extractor, chunker: doc.chunker },
          chunk: { index: hit.chunkIndex, start: hit.start, end: hit.end },
        },
      ],
    });

    // A later session: the file is not picked again, the stored original stands in.
    const later = open(name);
    await later.init();
    const report = /** @type {import('../../src/js/core/receipt.js').VerifyReport} */ (await later.verifyReceipt(receipt, [], null));
    assert.equal(report.summary.reproduced, 1);
    assert.equal(report.citations[0].file, 'match');
    assert.equal(report.citations[0].passage, 'match');
    assert.equal(report.citations[0].text, 'match');
    assert.equal(report.citations[0].chunk, 'match');
    // Without the stored originals the file is missing.
    const without = /** @type {import('../../src/js/core/receipt.js').VerifyReport} */ (await later.verifyReceipt(receipt, [], null, { stored: false }));
    assert.equal(without.citations[0].file, 'missing');
    assert.ok('invalid' in (await later.verifyReceipt({ schema: 'nope' }, [], null)));
  });
});
