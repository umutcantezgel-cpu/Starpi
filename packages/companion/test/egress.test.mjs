import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { installEgressGuard, openCapability, TRANSPORT_SEAM } from '../src/egress/guard.js';
import { canonicalHost, isInternalAddress, isLoopbackAddress, isPublicAddress, parseEgressEntry } from '../src/egress/hosts.js';
import { createSpliceServer, parseConnect, spliceTransport } from '../src/egress/splice.js';
import { checkEgressConfig } from '../src/config.js';
import { tempDir } from './helpers.mjs';

/** A loopback echo server that answers JSON with what it received. */
async function echoServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null, body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return { server, port, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

test('hosts: canonical forms and the public/internal split', () => {
  assert.equal(canonicalHost('https://User@API.Example.com:443/v1'), 'api.example.com');
  assert.equal(canonicalHost('[::ffff:127.0.0.1]:80'), '127.0.0.1');
  assert.equal(canonicalHost('exa mple.com'), null);
  for (const a of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1']) {
    assert.equal(isInternalAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '2606:4700:4700::1111', '8.8.8.8']) assert.equal(isPublicAddress(a), true, a);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.9'), true);
  assert.deepEqual(parseEgressEntry('API.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
  for (const bad of ['api.example.com:80', 'localhost:443', 'printer.local:443', '10.0.0.1:443', 'metadata.google.internal:443', 'intranet:443']) assert.equal(parseEgressEntry(bad), null, bad);
});

test('the egress list gives each host to one module only', () => {
  assert.deepEqual(checkEgressConfig({ allow: { brains: ['api.anthropic.com:443'], feeds: ['example.org:443'] } }), []);
  const problems = checkEgressConfig({ allow: { brains: ['api.anthropic.com:443'], relay: ['API.anthropic.com:443'] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /listed for brains already/);
  assert.ok(checkEgressConfig({ allow: { brains: ['api.anthropic.com:8443'] } }).length > 0);
});

test('guard: only loopback is reachable, DNS of other names and spawning are refused', async (t) => {
  const echo = await echoServer();
  /** @type {string[]} */
  const blocked = [];
  const guard = installEgressGuard({ onBlocked: (r) => blocked.push(r.api) });
  t.after(async () => {
    guard.uninstall();
    await echo.close();
  });
  await assert.rejects(fetch('https://example.com/'), (err) => /** @type {any} */ (err).cause?.code === 'EGRESS_BLOCKED');
  assert.throws(() => net.connect(443, '93.184.216.34'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  assert.throws(() => net.connect({ path: join('/tmp', 'any.sock') }), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  const dns = await import('node:dns');
  await assert.rejects(dns.promises.lookup('example.com'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  await assert.rejects(dns.promises.resolve4('example.com'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  const childProcess = await import('node:child_process');
  assert.throws(() => childProcess.spawn('true'), (err) => /** @type {any} */ (err).code === 'SPAWN_FORBIDDEN');
  assert.throws(() => childProcess.execFileSync('true'), (err) => /** @type {any} */ (err).code === 'SPAWN_FORBIDDEN');
  const { Worker } = await import('node:worker_threads');
  assert.throws(() => new Worker('process.exit(0)', { eval: true }), (err) => /** @type {any} */ (err).code === 'SPAWN_FORBIDDEN');
  assert.equal((await (await fetch(`http://127.0.0.1:${echo.port}/a`)).json()).path, '/a');
  assert.equal((await (await fetch(`http://localhost:${echo.port}/b`)).json()).path, '/b');
  assert.ok(blocked.includes('net.connect'));
  assert.throws(() => installEgressGuard(), /installed already/);
});

test('capability: reaches its listed hosts over https only, narrows, and dies with the guard', async (t) => {
  const echo = await echoServer();
  const guard = installEgressGuard({ [TRANSPORT_SEAM]: { plain: true, connect: async () => guard.rawConnect('127.0.0.1', echo.port) } });
  t.after(async () => {
    guard.uninstall();
    await echo.close();
  });
  const cap = guard.capability(['api.example.com:443', 'b.example.com:443']);
  assert.deepEqual([...cap.targets], ['api.example.com:443', 'b.example.com:443']);
  const res = await cap.fetch('https://api.example.com/v1/x?y=1', { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{"a":1}' });
  assert.deepEqual(await res.json(), { method: 'POST', path: '/v1/x?y=1', host: 'api.example.com', auth: 'Bearer t', body: '{"a":1}' });
  await assert.rejects(cap.fetch('https://c.example.com/'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  await assert.rejects(cap.fetch('http://api.example.com/'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  await assert.rejects(cap.fetch('https://api.example.com:8443/'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  const narrow = cap.narrow(['b.example.com:443']);
  await assert.rejects(narrow.fetch('https://api.example.com/'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  assert.throws(() => narrow.narrow(['api.example.com:443']), (err) => /** @type {any} */ (err).code === 'egress_entry');
  assert.throws(() => guard.capability(['localhost:443']), (err) => /** @type {any} */ (err).code === 'egress_entry');
  guard.uninstall();
  await assert.rejects(cap.fetch('https://api.example.com/'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
});

test('the guard-less capability keeps the same host rules', async () => {
  /** @type {string[]} */
  const seen = [];
  const cap = openCapability(['api.example.com:443'], async (input) => {
    seen.push(String(input));
    return new Response('{}');
  });
  await cap.fetch('https://api.example.com/x');
  await assert.rejects(cap.fetch('https://other.example.com/x'), (err) => /** @type {any} */ (err).code === 'EGRESS_BLOCKED');
  assert.deepEqual(seen, ['https://api.example.com/x']);
});

test('splice: CONNECT only to listed hosts with public addresses, then bytes both ways', async (t) => {
  const { dir, cleanup } = tempDir();
  const echo = await echoServer();
  /** @type {any[]} */
  const lines = [];
  const resolveTo = new Map([['api.example.com', ['93.184.216.34']], ['inside.example.com', ['10.0.0.5']]]);
  const splice = createSpliceServer({
    allow: ['api.example.com:443', 'inside.example.com:443'],
    resolve: async (host) => resolveTo.get(host) ?? [],
    connect: async () => net.connect(echo.port, '127.0.0.1'),
    log: (line) => lines.push(line),
  });
  const socketPath = join(dir, 'egress.sock');
  await new Promise((resolve) => splice.listen(socketPath, () => resolve(undefined)));
  const guard = installEgressGuard({ transport: (kernel) => ({ ...spliceTransport({ socketPath })(kernel), plain: true }) });
  t.after(async () => {
    guard.uninstall();
    await new Promise((resolve) => splice.close(() => resolve(undefined)));
    await echo.close();
    cleanup();
  });
  const cap = guard.capability(['api.example.com:443', 'inside.example.com:443', 'unlisted.example.com:443']);
  const res = await cap.fetch('https://api.example.com/spliced');
  assert.equal((await res.json()).path, '/spliced');
  await assert.rejects(cap.fetch('https://inside.example.com/'), (err) => /** @type {any} */ (err).reason === 'not_public');
  await assert.rejects(cap.fetch('https://unlisted.example.com/'), (err) => /** @type {any} */ (err).reason === 'not_allowed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lines.map((l) => l.result).sort(), ['not_allowed', 'not_public', 'ok']);
  assert.equal(parseConnect('CONNECT api.example.com:443 HTTP/1.1\r\nHost: x'), 'api.example.com');
  assert.equal(parseConnect('CONNECT api.example.com:80 HTTP/1.1'), null);
  assert.equal(parseConnect('GET / HTTP/1.1'), null);
});
