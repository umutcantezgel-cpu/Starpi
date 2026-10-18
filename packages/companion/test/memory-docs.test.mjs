// Notes, documents and the search index: explicit notes with ranking, documents with extraction
// and sealed storage, keyword and hybrid search over both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from './helpers.mjs';
import { client, embeddingServer, eventually, startModules } from './module-helpers.mjs';
import { rankNotes } from '../src/memory/rank.js';
import { sniffDocument } from '../src/docs/sniff.js';
import { createRetrieval } from '../src/retrieval/index.js';
import { parseLoopbackUrl } from '../src/setup/loopback.js';

/**
 * A one-page PDF with a text layer.
 * @param {string} line
 */
export function tinyPdf(line) {
  const content = `BT /F1 14 Tf 20 100 Td (${line.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('loopback addresses: only this machine, explicit port, no user or query', () => {
  assert.equal(parseLoopbackUrl('http://127.0.0.1:11434/v1/', 'x').url, 'http://127.0.0.1:11434/v1');
  assert.equal(parseLoopbackUrl('http://[::1]:8000', 'x').host, '::1');
  assert.equal(parseLoopbackUrl('mqtt://localhost:1883', 'x', { schemes: ['mqtt'] }).port, 1883);
  for (const bad of ['http://example.org:80/v1', 'http://10.0.0.2:80', 'http://127.0.0.1/v1', 'https://127.0.0.1:443', 'http://u:p@127.0.0.1:80', 'http://127.0.0.1:80/?q=1', 'mqtt://127.0.0.1:1883']) {
    assert.throws(() => parseLoopbackUrl(bad, 'x'), (err) => /** @type {any} */ (err).code === 'loopback_only', bad);
  }
});

test('ranking: a better match wins, use and pinning lift a note, unused notes fade', () => {
  const now = Date.UTC(2026, 9, 1);
  const iso = (/** @type {number} */ days) => new Date(now - days * 86_400_000).toISOString();
  const note = (/** @type {string} */ id, /** @type {any} */ extra = {}) => ({ id, text: id, title: id, tags: [], dataClass: 'personal', pinned: false, created: iso(0), updated: iso(0), recalls: { count: 0, last: null, days: [] }, ...extra });
  const fresh = note('note-a');
  const old = note('note-b', { updated: iso(90) });
  const used = note('note-c', { updated: iso(90), recalls: { count: 12, last: iso(1), days: ['2026-09-20', '2026-09-25', '2026-09-30'] } });
  const pinned = note('note-d', { updated: iso(400), pinned: true });
  const list = rankNotes([old, fresh, used, pinned], { now }).map((r) => r.note.id);
  assert.deepEqual(list, ['note-c', 'note-d', 'note-a', 'note-b'], 'a note in steady use leads, a pinned one never fades below fresh ones');
  const matches = new Map([['note-a', { score: 2, chunk: 0, text: 'a' }], ['note-b', { score: 8, chunk: 0, text: 'b' }]]);
  const asked = rankNotes([old, fresh, used, pinned], { now, matches });
  assert.deepEqual(asked.map((r) => r.note.id), ['note-b', 'note-a'], 'only matching notes, the better match first despite its age');
  assert.ok(/** @type {number} */ (asked[0].signals.freshness) < 0.2);
});

test('sniffing decides by bytes and name, never by the claimed type', () => {
  assert.equal(sniffDocument(Buffer.from('%PDF-1.7 ...'), 'x.txt'), 'pdf');
  assert.equal(sniffDocument(Buffer.from('# Title\ntext'), 'readme.md'), 'md');
  assert.equal(sniffDocument(Buffer.from('<!DOCTYPE html><p>x</p>'), 'page'), 'html');
  assert.equal(sniffDocument(Buffer.from('a,b\n1,2\n'), 'table.csv'), 'csv');
  assert.equal(sniffDocument(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'report.docx'), 'docx');
  assert.throws(() => sniffDocument(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'archive.zip'), (err) => /** @type {any} */ (err).status === 415);
  assert.throws(() => sniffDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), 'photo.txt'), (err) => /** @type {any} */ (err).status === 415);
  assert.throws(() => sniffDocument(Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'utf16.txt'), (err) => /** @type {any} */ (err).status === 415);
  assert.throws(() => sniffDocument(Buffer.alloc(0), 'empty.txt'), (err) => /** @type {any} */ (err).code === 'document_empty');
});

test('hybrid search: keywords alone, then fused with vectors from a loopback embedding server', async (t) => {
  const server = await embeddingServer();
  t.after(() => server.close());
  const { createEmbedder } = await import('../src/retrieval/embedder.js');
  const { createScheduler } = await import('../src/scheduler/scheduler.js');
  const scheduler = createScheduler();
  t.after(() => scheduler.stop());
  const index = createRetrieval({ embedder: createEmbedder({ baseUrl: `${server.url}/v1`, model: 'letters' }), scheduler });
  index.put({ id: 'doc-1', collection: 'documents', title: 'garden.md', dataClass: 'personal', text: 'The tomatoes need water every second day in summer.' });
  index.put({ id: 'note-1', collection: 'notes', title: 'bike', dataClass: 'secret', text: 'The bike lock code is written on the tomatoes box.' });
  index.put({ id: 'note-2', collection: 'notes', title: 'boiler', dataClass: 'public', text: 'Boiler service is due in spring.' });
  await index.settle();
  assert.equal(index.stats().vectors, 3);
  const { passages, dense } = await index.search('tomatoes water');
  assert.equal(dense, 'used');
  assert.equal(passages[0].id, 'doc-1');
  assert.ok(!passages.some((p) => p.id === 'note-1'), 'a secret note stays out below the default ceiling');
  const all = await index.search('tomatoes', { maxClass: 'secret', collections: ['notes'] });
  assert.deepEqual(all.passages.map((p) => p.id).slice(0, 1), ['note-1']);
  const posts = server.seen.filter((s) => s.url === '/v1/embeddings');
  assert.ok(posts.length >= 2 && posts.every((s) => s.body.model === 'letters'));
  index.stop();
});

test('hybrid search falls back to keywords when the embedding server fails', async (t) => {
  const server = await embeddingServer({ fail: true });
  t.after(() => server.close());
  const { createEmbedder } = await import('../src/retrieval/embedder.js');
  const { createScheduler } = await import('../src/scheduler/scheduler.js');
  const scheduler = createScheduler();
  t.after(() => scheduler.stop());
  const index = createRetrieval({ embedder: createEmbedder({ baseUrl: `${server.url}/v1`, model: 'letters' }), scheduler });
  index.put({ id: 'doc-1', collection: 'documents', title: 'a', dataClass: 'personal', text: 'Window cleaning on Fridays.' });
  await index.settle();
  const { passages, dense } = await index.search('window cleaning');
  assert.equal(passages.length, 1);
  assert.equal(dense, 'off', 'no vectors exist, so the dense branch is not asked');
  assert.equal(index.stats().dense?.state, 'failing');
  index.stop();
});

test('notes over HTTP: explicit add, recall with ranking, change, delete, erase followed', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['retrieval', 'notify', 'memory'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion);
  const a = await c.post('/v1/memory/notes', { text: 'The spare house key is with the neighbour at number 12.', tags: ['home'] });
  assert.equal(a.status, 201);
  const keyNote = a.json().note;
  assert.equal(keyNote.dataClass, 'personal');
  assert.equal(keyNote.title, 'The spare house key is with the neighbour at number 12.');
  await c.post('/v1/memory/notes', { text: 'Water the herbs on the balcony twice a week.', pinned: true });
  await c.post('/v1/memory/notes', { text: 'Wifi password: correct horse battery staple', dataClass: 'secret' });
  assert.equal((await c.post('/v1/memory/notes', { text: '' })).status, 400);
  assert.equal((await c.post('/v1/memory/notes', { text: 'x', colour: 'red' })).status, 400);

  const listed = (await c.get('/v1/memory/notes')).json().notes;
  assert.equal(listed.length, 3);
  assert.equal(listed[0].pinned, true, 'the pinned note leads the list');
  assert.ok(listed.every((/** @type {any} */ n) => !('text' in n)), 'the list has titles, no texts');

  const recalled = (await c.post('/v1/memory/recall', { query: 'where is the house key' })).json().notes;
  assert.equal(recalled[0].id, keyNote.id);
  assert.equal(recalled[0].recalls, 1);
  assert.match(recalled[0].passage.text, /neighbour/);
  const again = (await c.post('/v1/memory/recall', { query: 'house key', k: 1 })).json().notes;
  assert.equal(again.length, 1);
  assert.equal((await c.get(`/v1/memory/notes/${keyNote.id}`)).json().note.recalls.count, 2);

  const changed = await c.put(`/v1/memory/notes/${keyNote.id}`, { text: 'The spare key moved to the garage.', dataClass: 'sensitive' });
  assert.equal(changed.json().note.dataClass, 'sensitive');
  const after = (await c.post('/v1/memory/recall', { query: 'garage key' })).json().notes;
  assert.equal(after[0].id, keyNote.id);
  assert.equal((await c.del(`/v1/memory/notes/${keyNote.id}`)).status, 200);
  assert.equal((await c.get(`/v1/memory/notes/${keyNote.id}`)).status, 404);

  const kinds = companion.installation.chain.signedHead().seq;
  assert.ok(kinds > 0);
  const records = /** @type {any[]} */ (companion.installation.store.db.prepare("SELECT kind, subject FROM audit_log WHERE kind LIKE 'memory.%' ORDER BY seq").all());
  assert.deepEqual(records.map((r) => r.kind), ['memory.note_added', 'memory.note_added', 'memory.note_added', 'memory.note_changed', 'memory.note_deleted']);
  assert.equal(JSON.stringify(records).includes('neighbour'), false);

  // A crypto-erase of the namespace is followed without a restart.
  assert.equal((await c.post('/v1/vault/erase', { namespace: 'notes', confirm: 'notes' })).status, 200);
  assert.equal((await c.get('/v1/memory/notes')).json().notes.length, 0);
  assert.equal((await c.post('/v1/memory/recall', { query: 'balcony herbs' })).json().notes.length, 0);
});

test('documents: upload, extraction in the background, passages, original, duplicates, class and delete', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['retrieval', 'notify', 'memory', 'docs'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion, { role: 'member' });
  const body = '# Heating\n\nThe heating schedule starts at 06:30 on weekdays.\n\nIn July the heating stays off.';
  const up = await c.request('POST', `/v1/docs?name=${encodeURIComponent('heating notes.md')}`, { raw: body });
  assert.equal(up.status, 202);
  const doc = up.json().document;
  assert.equal(doc.type, 'md');
  assert.equal(doc.status, 'stored');
  const ready = await eventually(async () => {
    const d = (await c.get(`/v1/docs/${doc.id}`)).json().document;
    return d.status === 'indexed' ? d : null;
  });
  assert.ok(ready.passages >= 1);
  assert.equal(ready.chars, body.length);
  const passage = (await c.get(`/v1/docs/${doc.id}/passages/0`)).json().passage;
  assert.match(passage.text, /06:30/);
  assert.equal((await c.get(`/v1/docs/${doc.id}/passages/99`)).status, 404);

  const file = await c.get(`/v1/docs/${doc.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(String(file.headers.get('content-disposition')), /attachment; filename\*=UTF-8''heating%20notes\.md/);
  assert.equal(file.text, body);

  const dup = await c.request('POST', '/v1/docs?name=copy.md', { raw: body });
  assert.equal(dup.status, 200);
  assert.equal(dup.json().duplicate, true);
  assert.equal(dup.json().document.id, doc.id);

  const search = (await c.post('/v1/retrieval/search', { query: 'heating schedule weekdays' })).json();
  assert.equal(search.passages[0].id, doc.id);
  assert.equal(search.passages[0].collection, 'documents');

  assert.equal((await c.put(`/v1/docs/${doc.id}/class`, { dataClass: 'secret' })).json().document.dataClass, 'secret');
  assert.equal((await c.post('/v1/retrieval/search', { query: 'heating schedule' })).json().passages.length, 0, 'secret passages need an explicit ceiling');
  assert.equal((await c.post('/v1/retrieval/search', { query: 'heating schedule', maxClass: 'secret' })).json().passages.length, 1);

  // The original and the text are sealed: no plain text in the blob folder or the database.
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const blobDir = join(companion.installation.config.dataDir, 'vault', 'blobs', 'documents');
  const files = readdirSync(blobDir);
  assert.equal(files.length, 2);
  for (const f of files) assert.equal(readFileSync(join(blobDir, f)).includes(Buffer.from('heating')), false);

  assert.equal((await c.request('POST', '/v1/docs?name=photo.png', { raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) })).status, 415);
  assert.equal((await c.request('POST', '/v1/docs', { raw: 'text' })).status, 400, 'a name is required');
  assert.equal((await c.request('POST', '/v1/docs?name=a.txt', { raw: 'text', type: 'image/png' })).status, 415);

  assert.equal((await c.del(`/v1/docs/${doc.id}`)).status, 200);
  assert.equal((await c.get('/v1/docs')).json().documents.length, 0);
  assert.equal(readdirSync(blobDir).length, 0);
  const notes = (await c.get('/v1/notify')).json().notifications;
  assert.equal(notes[0].kind, 'document_ready');
  assert.equal(notes[0].ref, doc.id);
});

test('documents: the PDF text layer and HTML are read; an unreadable file is marked failed', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['retrieval', 'docs'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion);
  const pdf = (await c.request('POST', '/v1/docs?name=rain.pdf', { raw: tinyPdf('Rainfall in May was 41 mm.'), type: 'application/pdf' })).json().document;
  const html = (await c.request('POST', '/v1/docs?name=page.html', { raw: '<html><head><script>alert(1)</script></head><body><h1>Recipe</h1><p>Bake for 25 minutes.</p></body></html>', type: 'text/html' })).json().document;
  const broken = (await c.request('POST', '/v1/docs?name=data.json', { raw: '{"open": ' })).json().document;
  const states = await eventually(async () => {
    const docs = (await c.get('/v1/docs')).json().documents;
    return docs.every((/** @type {any} */ d) => d.status !== 'stored') ? docs : null;
  });
  const byId = new Map(states.map((/** @type {any} */ d) => [d.id, d]));
  assert.equal(byId.get(pdf.id).status, 'indexed');
  assert.equal(byId.get(pdf.id).pages, 1);
  assert.match((await c.get(`/v1/docs/${pdf.id}/passages/0`)).json().passage.text, /41 mm/);
  assert.equal(byId.get(html.id).status, 'indexed');
  const htmlText = (await c.get(`/v1/docs/${html.id}/passages/0`)).json().passage.text;
  assert.match(htmlText, /Bake for 25 minutes/);
  assert.equal(htmlText.includes('alert'), false);
  assert.equal(byId.get(broken.id).status, 'failed');
  assert.equal(byId.get(broken.id).reason, 'invalid_json');
});
