import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEventTypes, FEED_EVENT_TYPES } from '../src/contracts/index.js';
import { openStore } from '../src/store/sqlite.js';
import { openKeyring } from '../src/vault/keyring.js';
import { namespaceCodec } from '../src/vault/vault.js';
import { newKey } from '../src/vault/crypto.js';
import { feedLatestProjection, demoReadings, latestReadings } from '../src/profiles/minimal/index.js';
import { tempDir } from './helpers.mjs';

const types = () => {
  const t = createEventTypes();
  for (const e of FEED_EVENT_TYPES) t.register(e);
  return t;
};
/** @param {Record<string, unknown>} over */
const sample = (over = {}) => ({ type: 'feed.sample', source: 'demo-sensor', key: `k${Math.random()}`, at: '2026-03-01T10:00:00Z', class: 'public', body: { source_id: 'demo-sensor', series: 'room.temperature', value: 21, unit: '°C', ts_source: '2026-03-01T10:00:00Z', quality: 'good' }, ...over });

test('events are appended once per source and key, read in order, with linked rows', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const store = openStore({ path: join(dir, 'c.db'), types: types() });
  const first = store.append([sample({ key: 'a' }), sample({ key: 'b' })]);
  assert.equal(first.inserted.length, 2);
  const again = store.append([sample({ key: 'a' })]);
  assert.equal(again.duplicates, 1);
  assert.deepEqual(store.read().map((e) => e.key), ['a', 'b']);
  assert.equal(store.head().seq, 2);
  assert.deepEqual(store.verifyLinks(), []);
  assert.throws(() => store.append([sample({ key: 'c' }), sample({ key: 'd', type: 'feed.unknown' })]), /event refused/);
  assert.equal(store.head().seq, 2, 'an invalid event refuses the whole batch');
  assert.throws(() => store.db.exec("UPDATE events SET key = 'x' WHERE seq = 1"), /append-only/);
  store.close();
});

test('a row changed behind the store breaks the links from there on', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const store = openStore({ path: join(dir, 'c.db'), types: types() });
  store.append([sample({ key: 'a' }), sample({ key: 'b' }), sample({ key: 'c' })]);
  store.db.exec('DROP TRIGGER events_append_only_u');
  store.db.exec(`UPDATE events SET body = replace(body, '21', '99') WHERE seq = 2`);
  assert.deepEqual(store.verifyLinks(), [{ kind: 'events_link_mismatch', seq: 2 }]);
  store.close();
});

test('protected bodies are sealed in the file and readable through the codec', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const keyring = openKeyring({ file: join(dir, 'keyring.json'), kek: newKey(), provider: 'file' });
  const path = join(dir, 'c.db');
  const store = openStore({ path, types: types(), codec: namespaceCodec(keyring, 'events') });
  store.append([sample({ key: 'p', class: 'personal', body: { source_id: 'demo-sensor', series: 'heart.rate', value: 71.25, unit: 'bpm', ts_source: '2026-03-01T10:00:00Z', quality: 'good' } })]);
  assert.equal(store.read()[0].body.value, 71.25);
  store.checkpoint();
  store.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from('heart.rate')), false);
  assert.throws(() => openStore({ path, types: types() }).read(), /without the vault/);
});

test('projections catch up, and a new version replays the log', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const path = join(dir, 'c.db');
  const s1 = openStore({ path, types: types() });
  s1.append(demoReadings(Date.UTC(2026, 2, 1, 6)));
  s1.close();
  const s2 = openStore({ path, types: types(), projections: [feedLatestProjection] });
  assert.equal(latestReadings(s2.db).length, 2, 'catch-up builds the view from the existing log');
  s2.append(demoReadings(Date.UTC(2026, 2, 1, 18)));
  const later = /** @type {any[]} */ (latestReadings(s2.db));
  assert.ok(later.every((r) => r.ts_source === '2026-03-01T18:00:00.000Z'));
  s2.close();
  const bumped = { ...feedLatestProjection, version: 2 };
  const s3 = openStore({ path, types: types(), projections: [bumped] });
  assert.equal(latestReadings(s3.db).length, 2);
  assert.equal(/** @type {any} */ (s3.db.prepare("SELECT version FROM projection_state WHERE name = 'feed_latest'").get()).version, 2);
  s3.close();
});

test('a database of a newer schema is not opened', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const path = join(dir, 'c.db');
  const s = openStore({ path });
  s.db.exec('PRAGMA user_version = 99');
  s.close();
  assert.throws(() => openStore({ path }), (err) => /** @type {any} */ (err).code === 'store_too_new');
});
