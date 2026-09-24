import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPublicKey } from '../../scripts/lib/supabase-key.mjs';

const jwt = (/** @type {object} */ payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

describe('assertPublicKey', () => {
  it('accepts publishable keys and anon JWTs', () => {
    assert.equal(assertPublicKey('sb_publishable_abc123'), 'publishable');
    assert.equal(assertPublicKey(jwt({ role: 'anon' })), 'anon-jwt');
  });

  it('refuses secret keys, service-role JWTs and garbage', () => {
    assert.throws(() => assertPublicKey('sb_secret_abc123'), /secret key/);
    assert.throws(() => assertPublicKey(jwt({ role: 'service_role' })), /role "anon"/);
    assert.throws(() => assertPublicKey('not-a-key'), /neither a publishable key/);
    assert.throws(() => assertPublicKey(''), /empty/);
  });
});
