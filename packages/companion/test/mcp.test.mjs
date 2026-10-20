// The MCP server: read-only tools for desktop clients, reached through the stdio bridge with a
// client token; cookies, browser sessions and web pages are refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';
import { APP, client, eventually, startModules } from './module-helpers.mjs';
import { readMessage } from '../src/mcp/jsonrpc.js';

const BRIDGE = fileURLToPath(new URL('../bin/mcp-stdio.mjs', import.meta.url));

/**
 * Runs the bridge with lines on stdin; resolves with the answers on stdout and the exit code.
 * @param {string[]} args
 * @param {unknown[]} messages
 * @param {number} expected  answers to wait for before closing stdin
 */
function runBridge(args, messages, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let out = '';
    let err = '';
    /** @type {any[]} */
    const answers = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the bridge did not finish: ${err}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      let cut;
      while ((cut = out.indexOf('\n')) >= 0) {
        answers.push(JSON.parse(out.slice(0, cut)));
        out = out.slice(cut + 1);
      }
      if (answers.length >= expected) child.stdin.end();
    });
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ answers, code, stderr: err });
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    if (expected === 0) child.stdin.end();
  });
}

test('JSON-RPC messages are classified strictly', () => {
  assert.equal(readMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).kind, 'invalid');
  assert.equal(readMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }).kind, 'request');
  assert.equal(readMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }).kind, 'notification');
  assert.equal(readMessage({ jsonrpc: '2.0', id: 1, result: {} }).kind, 'response');
  assert.equal(readMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }).kind, 'invalid');
  assert.equal(readMessage({ jsonrpc: '2.0', id: 1.5, method: 'ping' }).kind, 'invalid');
});

test('MCP over the stdio bridge lists exactly the read-only tools and answers them', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['retrieval', 'notify', 'memory', 'docs', 'agenda', 'mcp'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const owner = await client(companion);
  const doc = (await owner.request('POST', '/v1/docs?name=bikes.md', { raw: 'Bike service checklist: pump the tyres to 3.5 bar and oil the chain.' })).json().document;
  await eventually(async () => (await owner.get(`/v1/docs/${doc.id}`)).json().document.status === 'indexed');
  await owner.request('POST', '/v1/docs?name=diary.md&class=sensitive', { raw: 'Private diary: the bike was a birthday present.' });
  await owner.post('/v1/memory/notes', { text: 'The bike shop opens at 9 on Saturdays.' });
  await owner.post('/v1/memory/notes', { text: 'Bike lock combination 1234', dataClass: 'secret' });
  await owner.post('/v1/agenda', { title: 'Collect the bike', rule: { type: 'daily', time: '17:00' } });

  const made = await owner.post('/v1/mcp/clients', { label: 'Desktop assistant' });
  assert.equal(made.status, 201);
  const { token, client: info } = made.json();
  assert.equal(info.tools.length, 4);
  assert.equal(JSON.stringify((await owner.get('/v1/mcp/clients')).json()).includes(token), false, 'the list never shows a token');
  const tokenFile = join(dir, 'mcp.token');
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);

  const port = String(companion.port);
  const { answers, code } = /** @type {any} */ (await runBridge(['--token-file', tokenFile, '--port', port], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_documents', arguments: { query: 'bike tyres pressure' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_excerpt', arguments: { document: doc.id, passage: 0 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'recall_notes', arguments: { query: 'bike shop lock' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_agenda', arguments: { days: 2 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_documents', arguments: { query: 'x', colour: 'red' } } },
    { jsonrpc: '2.0', id: 8, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
  ], 9));
  assert.equal(code, 0);
  const byId = new Map(answers.map((/** @type {any} */ a) => [a.id, a]));
  assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
  assert.deepEqual(byId.get(1).result.capabilities, { tools: { listChanged: false } });
  const tools = byId.get(2).result.tools;
  assert.deepEqual(tools.map((/** @type {any} */ x) => x.name).sort(), ['list_agenda', 'read_excerpt', 'recall_notes', 'search_documents']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const search = byId.get(3).result;
  assert.equal(search.isError, false);
  assert.match(search.content[0].text, /3\.5 bar/);
  assert.equal(search.structuredContent.passages[0].document, doc.id);
  assert.ok(!search.content[0].text.includes('diary'), 'a sensitive document stays above the default ceiling');
  assert.match(byId.get(4).result.content[0].text, /oil the chain/);
  const notes = byId.get(5).result;
  assert.match(notes.content[0].text, /opens at 9/);
  assert.equal(notes.content[0].text.includes('1234'), false, 'secret notes never leave');
  assert.match(byId.get(6).result.content[0].text, /Collect the bike/);
  assert.equal(byId.get(7).error.code, -32602);
  assert.equal(byId.get(8).error.code, -32601);
  assert.equal(byId.get(9).error.code, -32602);
  const calls = /** @type {any[]} */ (companion.installation.store.db.prepare("SELECT details FROM audit_log WHERE kind = 'mcp.call'").all());
  assert.equal(calls.length, 4);
  assert.equal(calls.some((c) => c.details.includes('tyres')), false, 'no query in the audit chain');
});

test('the MCP endpoint is bearer only: cookies, browser sessions, pages and revoked tokens are refused', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['mcp'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const owner = await client(companion);
  const { token, client: info } = (await owner.post('/v1/mcp/clients', { label: 'editor', tools: ['list_agenda'] })).json();
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  /** @param {Record<string, string>} headers */
  const post = (headers) => fetch(`${companion.url}/v1/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(ping) });
  const ok = await post({ authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { jsonrpc: '2.0', id: 1, result: {} }, 'a JSON-RPC answer carries nothing else');
  assert.ok(ok.headers.get('x-companion-audit-head'));
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: `Bearer ${owner.token}` })).status, 401, 'a paired browser token is no MCP token');
  assert.equal((await post({ authorization: `Bearer ${token}`, origin: APP })).status, 403);
  assert.equal((await post({ authorization: `Bearer ${token}`, cookie: 'a=b' })).status, 403);
  assert.equal((await post({ authorization: `Bearer ${token}`, 'mcp-protocol-version': '1999-01-01' })).status, 400);
  assert.equal((await fetch(`${companion.url}/v1/mcp`)).status, 405);
  const list = await (await fetch(`${companion.url}/v1/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
  assert.deepEqual(list.result.tools.map((/** @type {any} */ x) => x.name), ['list_agenda'], 'a client sees only its tools');

  assert.equal((await owner.del(`/v1/mcp/clients/${info.id}`)).status, 200);
  const tokenFile = join(dir, 'revoked.token');
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, 0o600);
  const { answers } = /** @type {any} */ (await runBridge(['--token-file', tokenFile, '--port', String(companion.port)], [ping], 1));
  assert.equal(answers[0].error.code, -32003);
  assert.equal(answers[0].error.data.status, 401);

  chmodSync(tokenFile, 0o644);
  const loose = /** @type {any} */ (await runBridge(['--token-file', tokenFile, '--port', String(companion.port)], [], 0));
  assert.equal(loose.code, 2);
  assert.match(loose.stderr, /chmod 600/);
  const argToken = /** @type {any} */ (await runBridge(['--token', token], [], 0));
  assert.equal(argToken.code, 2);
  assert.equal(argToken.stderr.includes(token), false, 'the token is never echoed');
});
