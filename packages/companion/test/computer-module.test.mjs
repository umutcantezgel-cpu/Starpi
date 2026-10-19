// The computer module inside a running companion: off by default, routes and roles over HTTP with a
// local model server fake and the mock actor, the records in the audit chain, the refused macOS
// actor, and no way to start a process from the module's code.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig, loadConfig } from '../src/config.js';
import { startCompanion } from '../src/service.js';
import { createMockActor, DEMO_SCENE } from '../src/computer/actor-mock.js';
import { MACOS_ACTOR_STATUS, createMacosActor, neutralRole, planMacosCall } from '../src/computer/actor-macos.js';
import { assertActor } from '../src/computer/actor.js';
import { createComputerModule, experimentalModules } from '../src/computer/module.js';
import { call, pairOver, testConfig, tempDir } from './helpers.mjs';

const APP = 'https://www.starpi.app';
const SRC = fileURLToPath(new URL('../src/computer/', import.meta.url));

/** A chat-completions server on loopback that answers with the queued texts, one per request. */
async function fakeModelServer(replies) {
  const queue = [...replies];
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const text = queue.shift() ?? JSON.stringify({ done: 'Nothing left to do.' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model: 'fake', choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: 'fake', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, push: (t) => queue.push(t), close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @param {() => Promise<boolean> | boolean} check */
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('off by default: no experimental flag, no module, no routes; the flag is checked strictly', async (t) => {
  const { dir, cleanup } = tempDir();
  const config = testConfig(dir);
  assert.deepEqual(config.experimental, { computer: false });
  assert.deepEqual(experimentalModules(config), []);
  assert.deepEqual(experimentalModules({ experimental: { computer: 'yes' } }), []);
  assert.equal(experimentalModules({ experimental: { computer: true } })[0].id, 'computer');
  assert.deepEqual(checkConfig({ experimental: { computer: true } }), []);
  assert.deepEqual(checkConfig({ experimental: { computer: 'yes' } }), ['config.experimental: experimental.computer: true or false']);
  assert.deepEqual(checkConfig({ experimental: { mouse: true } }), ['config.experimental: experimental.mouse: not a member']);
  const env = { XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_STATE_HOME: join(dir, 'state') };
  assert.equal(loadConfig({ env, platform: 'linux', home: dir }).experimental.computer, false);

  const companion = await startCompanion({ config, env: {}, modules: experimentalModules(config) });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const owner = await pairOver(companion, { origin: APP });
  const res = await call(`${companion.url}/v1/computer`, { origin: APP, headers: { authorization: `Bearer ${owner.body.token}` } });
  assert.equal(res.status, 404);
  assert.deepEqual(companion.status().modules, []);
});

test('the macOS actor is a preview: refused in the configuration, impossible to construct, unreachable from the module', async (t) => {
  assert.equal(MACOS_ACTOR_STATUS.verifiedOnHardware, false);
  assert.equal(MACOS_ACTOR_STATUS.note, 'preview, not verified on hardware');
  assert.throws(() => createMacosActor(), (err) => err.code === 'computer_actor_preview');
  assert.throws(() => assertActor({ ...createMockActor(), preview: true }), /preview/);
  // Values never enter script text: they follow the separator.
  const typed = /** @type {{ file: string, args: string[] }} */ (planMacosCall({ action: 'keyboard.type', text: '"); do shell script "x' }));
  assert.equal(typed.file, '/usr/bin/osascript');
  assert.equal(typed.args.at(-1), '"); do shell script "x');
  assert.equal(typed.args.at(-2), '--');
  assert.equal(typed.args.slice(0, -2).join(' ').includes('shell script'), false);
  assert.deepEqual(planMacosCall({ action: 'app.open', app: 'org.example.calc' }), { file: '/usr/bin/open', args: ['-b', 'org.example.calc'] });
  assert.equal(planMacosCall({ action: 'keyboard.press', key: 'alt+x' }), null);
  assert.equal(planMacosCall({ action: 'pointer.scroll' }), null);
  assert.equal(neutralRole('AXTextField', 'AXSecureTextField'), 'password');
  assert.equal(neutralRole('AXSearchField'), 'searchbox');

  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const config = testConfig(dir, { experimental: { computer: true }, modules: { computer: { actor: 'macos' } } });
  await assert.rejects(startCompanion({ config, env: {}, modules: experimentalModules(config) }), (err) => err.code === 'computer_config' && /preview, not verified on hardware/.test(err.message));
  const wrong = testConfig(dir, { experimental: { computer: true }, modules: { computer: { mandateSeconds: 600 } } });
  await assert.rejects(startCompanion({ config: wrong, env: {}, modules: experimentalModules(wrong) }), (err) => err.code === 'computer_config' && /mandateSeconds/.test(err.message));
});

test('no file of the module can start a process, and only tests reach the macOS actor factory', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.doesNotMatch(source, /child_process|worker_threads|node:cluster|\bspawn\(|\bexecFile\(|process\.execve|new Worker\(/, `${file} must not start processes`);
    if (file !== 'actor-macos.js') assert.doesNotMatch(source, /createMacosActor\(/, `${file} must not construct the macOS actor`);
  }
});

test('over HTTP: consent by the owner, a mandate, an approval only by its owner, the journal, stop by a member, every step in the chain', async (t) => {
  const { dir, cleanup } = tempDir();
  const model = await fakeModelServer([
    JSON.stringify({ steps: [{ do: 'screen.look', why: 'see the note' }] }),
    JSON.stringify({ steps: [{ do: 'pointer.click', at: [600, 300], why: 'focus the note' }, { do: 'keyboard.type', text: 'Hello there', why: 'write a greeting' }] }),
    JSON.stringify({ done: 'Wrote a greeting into the note.' }),
  ]);
  const actor = createMockActor({ scene: DEMO_SCENE });
  const config = testConfig(dir, {
    experimental: { computer: true },
    brains: [{ id: 'local', type: 'openai-compat', baseUrl: model.url, model: 'fake' }],
    modules: { computer: { mandateSeconds: 60 } },
  });
  /** @type {import('../src/service.js').Companion | null} */
  let running = null;
  t.after(async () => {
    await running?.stop();
    await model.close();
    cleanup();
  });
  const companion = await startCompanion({ config, env: {}, modules: experimentalModules(config, { actor }) });
  running = companion;
  const base = `${companion.url}/v1/computer`;
  const ownerA = (await pairOver(companion, { origin: APP, role: 'owner' })).body.token;
  const ownerB = (await pairOver(companion, { origin: APP, role: 'owner' })).body.token;
  const member = (await pairOver(companion, { origin: APP, role: 'member' })).body.token;
  const as = (token, method = 'GET', body) => ({ origin: APP, method, body, headers: { authorization: `Bearer ${token}` } });

  const first = (await call(`${base}`, as(member))).json();
  assert.equal(first.actor.kind, 'mock');
  assert.equal(first.consent.granted, false);
  assert.deepEqual(first.offered, ['screen.look', 'pointer.click', 'pointer.scroll', 'keyboard.type', 'keyboard.press']);
  assert.ok(first.auditHead, 'answers carry the signed audit head');
  assert.equal((await call(`${base}/consent`, as(member, 'POST', { grant: true, version: 1 }))).status, 403, 'members do not grant consent');
  const early = await call(`${base}/mandate`, as(ownerA, 'POST', { task: 'Write a short greeting in the note' }));
  assert.equal(early.status, 409);
  assert.equal(early.json().error.code, 'consent_missing');
  assert.equal((await call(`${base}/consent`, as(ownerA, 'POST', { grant: true }))).json().error.code, 'consent_version');
  assert.equal((await call(`${base}/consent`, as(ownerA, 'POST', { grant: true, version: 1 }))).status, 200);
  assert.equal((await call(`${base}/mandate`, as(member, 'POST', { task: 'x' }))).status, 403, 'members do not start mandates');

  const started = await call(`${base}/mandate`, as(ownerA, 'POST', { task: 'Write a short greeting in the note' }));
  assert.equal(started.status, 200);
  const mandate = started.json().mandate;
  await until(async () => (await call(`${base}`, as(ownerA))).json().approval !== null);
  const seenByA = (await call(`${base}`, as(ownerA))).json();
  assert.equal(seenByA.approval.preview.text, 'Hello there');
  assert.equal(seenByA.mandate.mine, true);
  assert.equal(seenByA.mandate.screenRead, true);
  const seenByB = (await call(`${base}`, as(ownerB))).json();
  assert.equal(seenByB.approval.preview, undefined);
  assert.equal(seenByB.mandate.mine, false);
  const id = seenByA.approval.id;
  const byB = await call(`${base}/approvals/${id}`, as(ownerB, 'POST', { decision: 'allow' }));
  assert.equal(byB.status, 403);
  assert.equal(byB.json().error.code, 'not_mandate_owner');
  assert.equal((await call(`${base}/approvals/${id}`, as(member, 'POST', { decision: 'allow' }))).status, 403);
  assert.equal((await call(`${base}/mandate/extend`, as(ownerB, 'POST', { mandate }))).json().error.code, 'not_mandate_owner');
  // The click just ran: within the quiet period an approval is refused, then it goes through.
  let decided;
  await until(async () => {
    decided = await call(`${base}/approvals/${id}`, as(ownerA, 'POST', { decision: 'allow' }));
    if (decided.status === 409) assert.equal(decided.json().error.code, 'actor_busy');
    return decided.status !== 409;
  });
  assert.equal(decided.status, 200);
  await until(async () => (await call(`${base}`, as(ownerA))).json().mandate === null);
  assert.equal(actor.scene().elements.find((e) => e.label === 'Note text').value, 'Hello there');
  const after = (await call(`${base}`, as(ownerA))).json();
  assert.equal(after.notes.at(-1).text, 'Wrote a greeting into the note.');
  assert.equal(after.notes.at(-1).kind, 'model');
  assert.equal(model.seen[0].messages[0].role, 'system');
  assert.match(model.seen[1].messages.at(-1).content, /Note text/, 'the screen report went back to the model');

  assert.equal((await call(`${base}/journal`, as(member))).status, 403);
  const journal = (await call(`${base}/journal`, as(ownerA))).json();
  assert.deepEqual(journal.steps.map((s) => [s.action, s.cls, s.outcome]), [['screen.look', 'read', 'done'], ['pointer.click', 'low', 'done'], ['keyboard.type', 'high', 'done']]);

  const kinds = companion.installation.store.db.prepare("SELECT kind, details FROM audit_log WHERE kind LIKE 'computer.%' ORDER BY seq").all().map((r) => r.kind);
  assert.deepEqual(kinds.filter((k) => !k.startsWith('computer.request')), [
    'computer.consent.granted', 'computer.mandate.started', 'computer.turn', 'computer.step', 'computer.turn', 'computer.step',
    'computer.approval.asked', 'computer.approval.decided', 'computer.step', 'computer.turn', 'computer.mandate.ended',
  ]);
  const chainText = JSON.stringify(companion.installation.store.db.prepare('SELECT details FROM audit_log').all());
  assert.equal(chainText.includes('Hello there'), false);
  assert.equal(chainText.includes('greeting in the note'), false);
  assert.equal((await call(`${companion.url}/v1/audit/verify`, as(ownerA))).json().report.ok, true);

  // Stop by a member, with a step that would never finish on its own.
  actor.setScene({ ...DEMO_SCENE, stalls: ['pointer.click'] });
  model.push(JSON.stringify({ steps: [{ do: 'pointer.click', at: [420, 30], why: 'make a new note' }] }));
  await until(async () => (await call(`${base}/mandate`, as(ownerA, 'POST', { task: 'Make a new note' }))).status === 200);
  await until(() => actor.busy() === 1);
  const stopped = await call(`${base}/stop`, as(member, 'POST', {}));
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json().stopped, true);
  assert.ok(stopped.json().stopMs < 1000);
  assert.equal(actor.busy(), 0);
  const final = (await call(`${base}`, as(member))).json();
  assert.equal(final.stopped, true);
  assert.equal(final.mandate, null);
  const reasons = companion.installation.store.db.prepare("SELECT details FROM audit_log WHERE kind = 'computer.mandate.ended' ORDER BY seq").all().map((r) => JSON.parse(r.details).reason);
  assert.deepEqual(reasons, ['finished', 'stopped']);
});

test('without a model the mandate ends as failed; a running mandate ends with the companion; consent survives', async (t) => {
  const { dir, cleanup } = tempDir();
  // A model server that takes requests and never answers: the mandate stays in its first turn.
  const held = [];
  const silent = createServer((req, res) => held.push(res));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const silentUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (silent.address()).port}/v1`;
  /** @type {Array<{ stop: () => Promise<void> }>} */
  const started = [];
  t.after(async () => {
    for (const c of started.reverse()) await c.stop();
    for (const res of held) res.destroy();
    await new Promise((resolve) => silent.close(resolve));
    cleanup();
  });
  /** @param {Record<string, unknown>} extra */
  const boot = async (extra = {}) => {
    const config = testConfig(dir, { experimental: { computer: true }, ...extra });
    const c = await startCompanion({ config, env: {}, modules: [createComputerModule({ actor: createMockActor() })] });
    started.push(c);
    const token = (await pairOver(c, { origin: APP, role: 'owner' })).body.token;
    const as = (method = 'GET', body) => ({ origin: APP, method, body, headers: { authorization: `Bearer ${token}` } });
    return { c, as, base: `${c.url}/v1/computer` };
  };
  const endReasons = (c) => c.installation.store.db.prepare("SELECT details FROM audit_log WHERE kind = 'computer.mandate.ended' ORDER BY seq").all().map((r) => JSON.parse(r.details).reason);

  // No model configured: the router answers with its template and the loop ends the mandate.
  const one = await boot();
  await call(`${one.base}/consent`, one.as('POST', { grant: true, version: 1 }));
  assert.equal((await call(`${one.base}/mandate`, one.as('POST', { task: 'Look at the screen' }))).status, 200);
  await until(async () => (await call(one.base, one.as())).json().mandate === null);
  assert.equal((await call(one.base, one.as())).json().notes.at(-1).code, 'no_model');
  assert.deepEqual(endReasons(one.c), ['failed']);
  await one.c.stop();

  // A model that never answers: the mandate is still running when the companion stops.
  const two = await boot({ brains: [{ id: 'quiet', type: 'openai-compat', baseUrl: silentUrl, model: 'none' }] });
  assert.equal((await call(two.base, two.as())).json().consent.granted, true, 'the consent survived the restart');
  assert.equal((await call(`${two.base}/mandate`, two.as('POST', { task: 'Look at the screen' }))).status, 200);
  await until(() => held.length === 1);
  assert.notEqual((await call(two.base, two.as())).json().mandate, null);
  await two.c.stop();

  const three = await boot();
  assert.deepEqual(endReasons(three.c), ['failed', 'shutdown']);
  const status = (await call(three.base, three.as())).json();
  assert.equal(status.consent.granted, true);
  assert.equal(status.mandate, null);
  assert.equal(status.stopped, false);
});
