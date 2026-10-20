import './setup.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { normalizeServerUrl } = await import('../../src/js/providers.js');
const { assistantTarget, computeModeOf, normalizeAssistant, normalizeChatMode, normalizeMode } = await import('../../src/js/state.js');
const { classifyError } = await import('../../src/js/supabase.js');

describe('normalizeServerUrl', () => {
  it('accepts https anywhere and http only on loopback', () => {
    assert.equal(normalizeServerUrl('http://localhost:8000/v1/'), 'http://localhost:8000/v1');
    assert.equal(normalizeServerUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(normalizeServerUrl('https://llm.example.com/v1?x=1#y'), 'https://llm.example.com/v1');
    assert.throws(() => normalizeServerUrl('http://llm.example.com/v1'));
    // Not in the CSP connect-src, so it must be rejected here instead of failing silently.
    assert.throws(() => normalizeServerUrl('http://[::1]:8000/v1'));
    assert.throws(() => normalizeServerUrl('javascript:alert(1)'));
    assert.throws(() => normalizeServerUrl('https://user:pass@example.com'));
    assert.throws(() => normalizeServerUrl('not a url'));
  });
});

describe('normalizeMode', () => {
  it('maps legacy values and rejects unknown ones', () => {
    assert.equal(normalizeMode('webgpu'), 'client');
    assert.equal(normalizeMode('cluster_b'), 'council');
    assert.equal(normalizeMode('local'), 'local');
    assert.equal(normalizeMode('nvidia'), 'nvidia');
    assert.equal(normalizeMode('constructor'), 'council');
    assert.equal(normalizeMode(undefined), 'council');
  });
});

describe('normalizeChatMode', () => {
  it('keeps Auto, Free and Grounded and defaults to Auto', () => {
    for (const mode of ['auto', 'free', 'grounded']) assert.equal(normalizeChatMode(mode), mode);
    for (const other of ['FREE', '__proto__', null, undefined, 1]) assert.equal(normalizeChatMode(other), 'auto');
  });
});

describe('assistant values', () => {
  it('accept auto, device and provider:model, and refuse everything else', () => {
    for (const value of ['auto', 'device', 'anthropic:claude-opus-5-5', 'nvidia:nvidia/nemotron-3-super-120b-a12b', 'local:*', 'local:llama3.2:3b', 'openrouter:meta-llama/llama-3.3-70b-instruct:free']) assert.equal(normalizeAssistant(value), value);
    for (const value of ['council', 'webgpu:qwen-3b', 'wasm:x', 'anthropic:*', 'unknown:model', 'anthropic:', ':x', 'anthropic:has space', '__proto__', null, 7]) assert.equal(normalizeAssistant(value), null, String(value));
    assert.deepEqual(assistantTarget('local:llama3.2:3b'), { provider: 'local', model: 'llama3.2:3b' });
    assert.equal(assistantTarget('auto'), null);
  });

  it('map onto the 2.x compute modes for the modules that only ask where answers run', () => {
    assert.equal(computeModeOf('device'), 'client');
    assert.equal(computeModeOf('local:*'), 'local');
    assert.equal(computeModeOf('nvidia:x/y'), 'nvidia');
    assert.equal(computeModeOf('auto'), 'council');
    assert.equal(computeModeOf('anthropic:claude-opus-5-5'), 'council');
  });
});

describe('classifyError', () => {
  it('recognizes PostgREST, auth and network failures', () => {
    assert.equal(classifyError({ code: 'PGRST202', message: 'Could not find the function' }).kind, 'missing_function');
    assert.equal(classifyError({ code: '42703', message: 'column does not exist' }).kind, 'missing_schema');
    assert.equal(classifyError({ code: '42501', message: 'permission denied' }).kind, 'forbidden');
    assert.equal(classifyError({ code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled' }).kind, 'auth_disabled');
    assert.equal(classifyError({ message: 'TypeError: Failed to fetch', code: '' }).kind, 'network');
    assert.equal(classifyError(new DOMException('timeout', 'TimeoutError')).kind, 'timeout');
    assert.equal(classifyError('weird').kind, 'unknown');
  });
});

describe('vercel.json security headers', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const headers = Object.fromEntries(vercel.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
  const csp = Object.fromEntries(
    headers['Content-Security-Policy'].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]),
  );

  it('ships a strict script policy', () => {
    assert.deepEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
    for (const [directive, values] of Object.entries(csp)) {
      assert.ok(!values.includes("'unsafe-inline'"), `${directive} allows unsafe-inline`);
      assert.ok(!values.includes("'unsafe-eval'"), `${directive} allows unsafe-eval`);
    }
    assert.deepEqual(csp['object-src'], ["'none'"]);
    assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
    assert.deepEqual(csp['base-uri'], ["'none'"]);
    assert.ok(!csp['img-src'].includes('https:'), 'remote images would allow exfiltration beacons');
  });

  it('builds the static site from dist with a clean install', () => {
    assert.equal(vercel.outputDirectory, 'dist');
    assert.equal(vercel.installCommand, 'npm ci --ignore-scripts');
    assert.equal(vercel.buildCommand, 'npm run build');
    assert.ok(headers['Permissions-Policy'].includes('microphone=(self)'));
  });
});
