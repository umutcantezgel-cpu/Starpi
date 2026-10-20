// A workspace search limited to some documents (rag/workspace-core.js search/searchHybrid with
// docIds, as a project's grounded questions use it): the other documents are left out before the
// ranking, so the listed ones are found however many others rank higher, by keyword and by meaning.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { createWorkspace } from '../../src/js/rag/workspace-core.js';

let seq = 0;
const MODEL = { id: 'test/scope@abc/q8', dim: 3 };

/** @param {string} text @param {string} name */
const file = (text, name) => new File([text], name, { type: 'text/markdown' });

/** A 3-dimensional "embedding": counts of a few topic words. @param {string} text */
function embed(text) {
  const t = text.toLowerCase();
  const v = Float32Array.from([/harbour|ferry|pier/g, /orchard|apple|pear/g, /violin|concert/g].map((re) => (t.match(re) ?? []).length + 0.01));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** A workspace of 30 documents that all match "harbour" strongly, and one that mentions it once. */
async function setup() {
  const ws = createWorkspace({ openDb: () => openAppDb({ name: `ws-scope-${(seq += 1)}` }), fileRoot: null });
  await ws.init({ model: MODEL });
  for (let i = 0; i < 30; i += 1) await ws.ingest(file(`Harbour log ${i}: harbour ferry harbour pier harbour.`, `log-${i}.md`));
  const target = await ws.ingest(file('Orchard plan: the apple and pear rows run down towards the old harbour wall.', 'orchard.md'));
  const pending = ws.pendingVectors(500);
  await ws.putVectors(
    MODEL.id,
    pending.map((c) => ({ docId: c.docId, idx: c.idx, vector: embed(c.text) })),
  );
  return { ws, target };
}

describe('workspace search within some documents', () => {
  it('finds the listed document by keyword however many others rank higher', async () => {
    const { ws, target } = await setup();
    const everywhere = ws.search('harbour', 6);
    assert.equal(everywhere.length, 6);
    assert.ok(everywhere.every((h) => h.docId !== target.docId));
    // Even 24 hits of the whole workspace hold none of it (filtering afterwards would find nothing).
    assert.ok(ws.search('harbour', 24).every((h) => h.docId !== target.docId));
    const within = ws.search('harbour', 6, [target.docId]);
    assert.deepEqual(
      within.map((h) => h.docName),
      ['orchard.md'],
    );
    assert.deepEqual(ws.search('harbour', 6, []), []);
    // Without a list nothing changes.
    assert.deepEqual(ws.search('harbour', 6, null), everywhere);
  });

  it('keeps hybrid search within the listed documents, also for hits found by meaning only', async () => {
    const { ws, target } = await setup();
    const hits = ws.searchHybrid('harbour', embed('harbour'), 6, [target.docId]);
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.docId === target.docId));
    // "fruit trees" shares no word with the plan; its vector leads there all the same.
    const meaning = ws.searchHybrid('fruit trees', embed('apple orchard'), 6, [target.docId]);
    assert.equal(meaning[0]?.docName, 'orchard.md');
    assert.equal(meaning[0]?.keywordScore, null);
    const logs = ws.state().documents.filter((d) => d.docId !== target.docId).slice(0, 2).map((d) => d.docId);
    assert.ok(ws.searchHybrid('apple orchard', embed('apple orchard'), 6, logs).every((h) => logs.includes(h.docId)));
  });

  it('keeps the index statistics of the whole index for the listed documents', () => {
    const index = new BM25Index();
    index.add([
      { docId: 'a', docName: 'a', chunkIndex: 0, start: 0, end: 0, text: 'tide tables for the north pier' },
      { docId: 'b', docName: 'b', chunkIndex: 0, start: 0, end: 0, text: 'tide tide tide' },
      { docId: 'c', docName: 'c', chunkIndex: 0, start: 0, end: 0, text: 'concert hall seating' },
    ]);
    const all = index.search('tide pier', 5);
    const onlyA = index.search('tide pier', 5, (docId) => docId === 'a');
    assert.deepEqual(
      onlyA.map((h) => h.chunk.docId),
      ['a'],
    );
    assert.equal(onlyA[0].score, all.find((h) => h.chunk.docId === 'a')?.score);
  });
});
