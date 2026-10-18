import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

/**
 * Resolves with the error code a socket-like emitter reports, null once it emits `okEvent`, or
 * 'no answer' after a few seconds (a guard that let the connection out would wait on a black hole).
 * @param {import('node:events').EventEmitter} emitter @param {string} [okEvent]
 */
const outcome = (emitter, okEvent = 'connect') =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('no answer'), 5000);
    timer.unref();
    emitter.once('error', (err) => resolve(/** @type {any} */ (err).code ?? err.message));
    emitter.once(okEvent, () => resolve(null));
  });

test("guard: a caller's own lookup is run and its answer checked, for net, http and datagram sockets", async (t) => {
  const echo = await echoServer();
  /** @type {string[]} */
  const blocked = [];
  const guard = installEgressGuard({ onBlocked: (r) => blocked.push(`${r.api} ${r.target}`) });
  t.after(async () => {
    guard.uninstall();
    await echo.close();
  });
  const outside = '192.0.2.1';
  /** A lookup that answers every name with one address, in both answer shapes Node asks for. @param {string} address */
  const answering = (address) => (/** @type {string} */ _name, /** @type {any} */ options, /** @type {Function} */ callback) => {
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }, { address, family: net.isIP(address) }]);
    else callback(null, address, net.isIP(address));
  };

  assert.equal(await outcome(net.connect({ host: 'localhost', port: echo.port, lookup: answering(outside) })), 'EGRESS_BLOCKED');
  assert.equal(await outcome(net.connect({ host: 'localhost', port: echo.port, lookup: answering(outside), autoSelectFamily: false })), 'EGRESS_BLOCKED');
  assert.equal(await outcome(http.request({ host: 'localhost', port: echo.port, lookup: answering(outside) }).end()), 'EGRESS_BLOCKED');
  assert.ok(blocked.includes(`net.lookup localhost -> ${outside}`));

  // A lookup that stays on this machine is honoured.
  let asked = 0;
  const loopback = net.connect({ host: 'localhost', port: echo.port, lookup: (/** @type {string} */ name, /** @type {any} */ options, /** @type {Function} */ callback) => {
    asked += 1;
    answering('127.0.0.1')(name, options, callback);
  } });
  assert.equal(await outcome(loopback), null);
  loopback.destroy();
  assert.equal(asked, 1);

  // Every option is read once: a getter cannot turn the checked TCP target into a socket path.
  let reads = 0;
  const tricky = { host: 'localhost', port: echo.port };
  Object.defineProperty(tricky, 'path', { enumerable: true, get: () => (reads++ === 0 ? undefined : join('/tmp', 'other.sock')) });
  const plain = new net.Socket().connect(tricky);
  assert.equal(await outcome(plain), null);
  assert.equal(plain.remotePort, echo.port);
  plain.destroy();
  assert.equal(reads, 1);

  // Datagram sockets resolve even IP literals through their lookup.
  const dgram = (await import('node:dgram')).default;
  const receiver = dgram.createSocket('udp4');
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => receiver.close());
  const port = receiver.address().port;
  /** Answers the wildcard bind address as it is and every other name with the outside address. */
  const datagramLookup = (/** @type {string} */ name, /** @type {unknown} */ _family, /** @type {Function} */ callback) => callback(null, name === '0.0.0.0' ? name : outside, 4);
  const viaCreate = dgram.createSocket({ type: 'udp4', lookup: datagramLookup });
  const created = outcome(viaCreate, 'close');
  viaCreate.send('x', port, '127.0.0.1');
  assert.equal(await created, 'EGRESS_BLOCKED');
  viaCreate.close();
  const Ctor = /** @type {any} */ (dgram.Socket.prototype.constructor);
  const viaConstructor = new Ctor({ type: 'udp4', lookup: datagramLookup });
  assert.ok(viaConstructor instanceof dgram.Socket);
  const constructed = outcome(viaConstructor, 'close');
  viaConstructor.send('x', port, 'localhost');
  assert.equal(await constructed, 'EGRESS_BLOCKED');
  viaConstructor.close();
  assert.ok(blocked.includes(`dgram.lookup localhost -> ${outside}`));
  const fine = dgram.createSocket('udp4');
  const got = new Promise((resolve) => receiver.once('message', (msg) => resolve(String(msg))));
  fine.send('hello', port, '127.0.0.1');
  assert.equal(await got, 'hello');
  fine.close();
});

test('guard: every route to a new process is refused, except the runner starting a kernel program', async (t) => {
  const guard = installEgressGuard();
  t.after(() => guard.uninstall());
  const childProcess = (await import('node:child_process')).default;
  const forbidden = (/** @type {any} */ err) => err.code === 'SPAWN_FORBIDDEN';
  const child = new childProcess.ChildProcess();
  assert.throws(() => child.spawn({ file: '/bin/sh', args: ['sh', '-c', 'exit 0'], envPairs: [], stdio: ['pipe', 'pipe', 'pipe'] }), forbidden);
  if (typeof (/** @type {any} */ (process).execve) === 'function') {
    assert.throws(() => /** @type {any} */ (process).execve('/bin/sh', ['sh', '-c', 'exit 0'], {}), forbidden);
  }
  const workerThreads = (await import('node:worker_threads')).default;
  const OriginalLooking = /** @type {any} */ (workerThreads.Worker.prototype.constructor);
  assert.throws(() => new OriginalLooking('process.exit(0)', { eval: true }), forbidden);
  const { runProgram, KERNEL_PROGRAMS } = await import('../src/vault/kek/runner.js');
  const present = KERNEL_PROGRAMS.find((file) => file.endsWith('systemd-notify') && existsSync(file));
  if (present) {
    const result = await runProgram(present, ['--booted']);
    assert.equal(typeof result.code, 'number', 'the runner still starts its fixed programs under the guard');
  }
  await assert.rejects(runProgram('/bin/sh', ['-c', 'exit 0']), (/** @type {any} */ err) => err.code === 'program_not_allowed');
  guard.uninstall();
  assert.equal(workerThreads.Worker.prototype.constructor, workerThreads.Worker, 'uninstall puts the class back');
  assert.equal(childProcess.execFileSync('/bin/sh', ['-c', 'echo back']).toString().trim(), 'back');
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
