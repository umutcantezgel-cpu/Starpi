// End-to-end encryption of the chat sync (sync/crypto.js): a passphrase opens the key another
// browser made, a wrong one does not, records open only for their row and revision, row ids are
// opaque and stable, the opened keys cannot be exported, envelopes and ciphertext have exactly the
// shapes the database accepts, and record sizes are padded.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSyncKey,
  isKeyEnvelope,
  MAX_RECORD_BYTES,
  MIN_SYNC_PASSPHRASE_CHARS,
  openRecord,
  openSyncKey,
  passphraseLongEnough,
  rowIdFor,
  sealRecord,
  SYNC_KDF_ITERATIONS,
  SyncCryptoError,
} from '../../src/js/sync/crypto.js';

const PASSPHRASE = 'correct horse battery staple';

/** The CHECK constraints of chat_sync / chat_sync_keys (migrations/20261102000000_chat_sync.sql). */
const DB = {
  convId: /^[A-Za-z0-9_-]{32}$/,
  iv: /^[A-Za-z0-9+/]{16}$/,
  ciphertext: /^[A-Za-z0-9+/]+={0,2}$/,
  keyId: /^[A-Za-z0-9_-]{22}$/,
  salt: /^[A-Za-z0-9+/]{22}==$/,
  wrappedKey: /^[A-Za-z0-9+/]{64}$/,
};

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (/** @type {unknown} */ err) => err instanceof SyncCryptoError && err.code === code);
}

describe('sync key', () => {
  it('a passphrase opens the key another browser made; both seal and open the same records', async () => {
    const { envelope, keys } = await createSyncKey(PASSPHRASE);
    assert.equal(envelope.kdf, 'PBKDF2-SHA256');
    assert.equal(envelope.iterations, SYNC_KDF_ITERATIONS);
    assert.equal(SYNC_KDF_ITERATIONS, 600_000);
    assert.match(envelope.keyId, DB.keyId);
    assert.match(envelope.salt, DB.salt);
    assert.match(envelope.iv, DB.iv);
    assert.match(envelope.wrappedKey, DB.wrappedKey);
    assert.equal(JSON.stringify(envelope).includes(PASSPHRASE), false);

    // The second browser has only the envelope (from the server) and the passphrase.
    const other = await openSyncKey(PASSPHRASE, JSON.parse(JSON.stringify(envelope)));
    assert.equal(other.keyId, keys.keyId);
    const rowId = await rowIdFor(keys, 'starpi_conversation-1');
    assert.equal(await rowIdFor(other, 'starpi_conversation-1'), rowId);
    assert.match(rowId, DB.convId);
    assert.notEqual(await rowIdFor(keys, 'starpi_conversation-2'), rowId);

    const record = { v: 1, kind: 'conversation', id: 'starpi_conversation-1', text: 'Grüße, ünïcödé ✓' };
    const sealed = await sealRecord(keys, { rowId, rev: 3 }, record);
    assert.match(sealed.iv, DB.iv);
    assert.match(sealed.ciphertext, DB.ciphertext);
    assert.equal(sealed.ciphertext.length % 4, 0);
    assert.deepEqual(await openRecord(other, { rowId, rev: 3, ...sealed }), record);
  });

  it('a wrong passphrase, a short one and a changed envelope are refused', async () => {
    const { envelope } = await createSyncKey(PASSPHRASE);
    await rejectsWith(openSyncKey('correct horse battery stapler', envelope), 'wrong_passphrase');
    await rejectsWith(openSyncKey('', envelope), 'wrong_passphrase');
    // The key id is bound to the wrapped key.
    await rejectsWith(openSyncKey(PASSPHRASE, { ...envelope, keyId: 'AAAAAAAAAAAAAAAAAAAAAA' }), 'wrong_passphrase');
    await rejectsWith(createSyncKey('short pass'), 'too_short');
    assert.equal(passphraseLongEnough('x'.repeat(MIN_SYNC_PASSPHRASE_CHARS - 1)), false);
    assert.equal(passphraseLongEnough('ä'.repeat(MIN_SYNC_PASSPHRASE_CHARS)), true);
    assert.equal(passphraseLongEnough('😀'.repeat(MIN_SYNC_PASSPHRASE_CHARS - 1)), false, 'counted in characters, not UTF-16 units');
  });

  it('accepts only envelopes with at least 600 000 and at most 10 000 000 iterations and exact sizes', async () => {
    const { envelope } = await createSyncKey(PASSPHRASE);
    assert.equal(isKeyEnvelope(envelope), true);
    assert.equal(isKeyEnvelope({ ...envelope, iterations: 100_000 }), false);
    assert.equal(isKeyEnvelope({ ...envelope, iterations: 50_000_000 }), false);
    assert.equal(isKeyEnvelope({ ...envelope, kdf: 'PBKDF2-SHA1' }), false);
    assert.equal(isKeyEnvelope({ ...envelope, salt: 'c2hvcnQ=' }), false);
    assert.equal(isKeyEnvelope({ ...envelope, wrappedKey: envelope.wrappedKey.slice(4) }), false);
    await rejectsWith(openSyncKey(PASSPHRASE, { ...envelope, iterations: 1000 }), 'bad_envelope');
  });

  it('keeps the opened keys inside WebCrypto: they cannot be exported', async () => {
    const { keys } = await createSyncKey(PASSPHRASE);
    assert.equal(keys.enc.extractable, false);
    assert.equal(keys.ids.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', keys.enc));
    await assert.rejects(crypto.subtle.exportKey('raw', keys.ids));
  });
});

describe('records', () => {
  it('open only for their row, revision and key', async () => {
    const { keys } = await createSyncKey(PASSPHRASE);
    const { keys: otherAccount } = await createSyncKey(PASSPHRASE);
    const rowId = await rowIdFor(keys, 'starpi_a');
    const sealed = await sealRecord(keys, { rowId, rev: 2 }, { hello: 'world' });
    await rejectsWith(openRecord(keys, { rowId, rev: 3, ...sealed }), 'decrypt');
    await rejectsWith(openRecord(keys, { rowId: await rowIdFor(keys, 'starpi_b'), rev: 2, ...sealed }), 'decrypt');
    await rejectsWith(openRecord(otherAccount, { rowId, rev: 2, ...sealed }), 'decrypt');
    // A changed byte of the ciphertext.
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[5] ^= 1;
    await rejectsWith(openRecord(keys, { rowId, rev: 2, iv: sealed.iv, ciphertext: bytes.toString('base64') }), 'decrypt');
    await rejectsWith(openRecord(keys, { rowId, rev: 2, iv: 'short', ciphertext: sealed.ciphertext }), 'decrypt');
    // The same key under another account makes other row ids.
    assert.notEqual(await rowIdFor(otherAccount, 'starpi_a'), rowId);
  });

  it('pads sizes to 512-byte steps, uses a fresh IV each time and refuses records above the limit', async () => {
    const { keys } = await createSyncKey(PASSPHRASE);
    const rowId = await rowIdFor(keys, 'starpi_a');
    const small = await sealRecord(keys, { rowId, rev: 1 }, { t: 'hi' });
    const larger = await sealRecord(keys, { rowId, rev: 1 }, { t: 'x'.repeat(300) });
    const again = await sealRecord(keys, { rowId, rev: 1 }, { t: 'hi' });
    assert.equal(small.ciphertext.length, larger.ciphertext.length, 'both fit one 512-byte step');
    assert.equal(Buffer.from(small.ciphertext, 'base64').length, 512 + 16);
    assert.notEqual(small.iv, again.iv);
    assert.notEqual(small.ciphertext, again.ciphertext);
    await rejectsWith(sealRecord(keys, { rowId, rev: 1 }, { t: 'x'.repeat(MAX_RECORD_BYTES) }), 'too_large');
    // The largest record still fits the database limit of 2 800 000 base64 characters.
    const biggest = await sealRecord(keys, { rowId, rev: 1 }, { t: 'x'.repeat(MAX_RECORD_BYTES - 20) });
    assert.ok(biggest.ciphertext.length <= 2_800_000, String(biggest.ciphertext.length));
  });
});
