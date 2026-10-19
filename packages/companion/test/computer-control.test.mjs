// The controller and the agent loop of the computer control with the mock actor, a scripted model
// and a manual clock: consent, mandate expiry and active extension, stop, approvals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/lib/canonical.js';
import { manualClock } from '../src/lib/clock.js';
import { createMockActor, DEMO_SCENE } from '../src/computer/actor-mock.js';
import { createAgentLoop, readPlan } from '../src/computer/agent.js';
import { createController } from '../src/computer/control.js';
import { CONSENT_STATEMENT } from '../src/computer/limits.js';
import { buildPolicy } from '../src/computer/lists.js';
import { openComputerState } from '../src/computer/state.js';

const OWNER = { session: 'a1a1a1a1-0000-4000-8000-000000000001', role: 'owner' };
const SECOND_OWNER = { session: 'b2b2b2b2-0000-4000-8000-000000000002', role: 'owner' };
const MEMBER = { session: 'c3c3c3c3-0000-4000-8000-000000000003', role: 'member' };

/** Lets promise chains and immediate callbacks run. */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
/** Waits until a condition holds (real time, short). */
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
/** The code of a refusal thrown by the controller. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, status: err.status };
  }
  return null;
}

/** A plan text. */
const plan = (...steps) => JSON.stringify({ steps });
const done = (text = 'Finished the task.') => JSON.stringify({ done: text });

/**
 * A scripted model: each call takes the next entry (text, or an async function of the request and
 * signal returning text); with nothing left it waits until the request is aborted.
 */
function scriptedModel(entries = []) {
  const queue = [...entries];
  const requests = [];
  return {
    requests,
    async complete(request, { signal }) {
      requests.push(request);
      const next = queue.shift();
      const text = next === undefined
        ? await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        })
        : typeof next === 'function' ? await next(request, signal) : next;
      if (text && typeof text === 'object') return text;
      return { text, reasoning: '', stopReason: 'end_turn', brain: 'scripted', model: 'scripted', locality: 'local', source: 'model', notice: null, usage: null, reset: false, attempts: [] };
    },
  };
}

/**
 * A controller wired to a mock actor, a scripted model, an in-memory vault namespace and a manual clock.
 * `wrap` may put a layer around the mock actor (the controller gets the wrapped one).
 */
function rig({ scene = DEMO_SCENE, model = [], settings = {}, lists = {}, store = new Map(), wrap = (a) => a } = {}) {
  const clock = manualClock();
  const space = {
    getJson: (id) => (store.has(id) ? JSON.parse(store.get(id)) : null),
    putJson: (id, value) => store.set(id, JSON.stringify(value)),
  };
  const records = [];
  const audit = {
    append(entry) {
      assert.match(entry.kind, /^computer\./);
      records.push(entry);
      return entry;
    },
  };
  const actor = createMockActor({ scene });
  const policy = buildPolicy(lists, { ownOrigins: ['https://app.example.org'] });
  const state = openComputerState(space);
  const controller = createController({ actor: wrap(actor), state, audit, clock, policy, settings: { mandateS: 120, approvalS: 60, holdS: 15, quietMs: 2000, ...settings } });
  const brains = scriptedModel(model);
  controller.useLoop(createAgentLoop({ controller, brains, policy }).drive);
  const kinds = (kind) => records.filter((r) => r.kind === kind);
  const ended = () => kinds('computer.mandate.ended').map((r) => r.details.reason);
  return { clock, store, state, records, actor, controller, brains, kinds, ended };
}

test('plans are read strictly', () => {
  assert.equal(readPlan('{"done":"ok"}').kind, 'done');
  assert.deepEqual(readPlan('Sure!\n```json\n{"steps":[{"do":"screen.look","why":"see"}]}\n```').steps, [{ action: 'screen.look', why: 'see', args: {} }]);
  assert.deepEqual(readPlan('{"steps":[{"do":"pointer.click","why":"open it","at":[3,4]}]}').steps[0].args, { at: [3, 4] });
  assert.equal(readPlan('no json here').problem, 'plan_not_json');
  assert.equal(readPlan('{"steps":[]}').problem, 'plan_shape');
  assert.equal(readPlan('{"steps":[{"do":"screen.look"}]}').problem, 'purpose_missing');
  assert.equal(readPlan('{"done":"x","steps":[]}').problem, 'plan_shape');
  assert.equal(readPlan(JSON.stringify({ steps: Array.from({ length: 7 }, () => ({ do: 'screen.look', why: 'see' })) })).problem, 'plan_shape');
});

test('consent: no mandate without it, the grant is recorded with the statement, withdrawing ends the mandate', async () => {
  const r = rig();
  assert.deepEqual(refusal(() => r.controller.startMandate(OWNER, { task: 'Tidy the note' })), { code: 'consent_missing', status: 409 });
  assert.equal(r.kinds('computer.request.refused')[0].details.code, 'consent_missing');
  assert.deepEqual(refusal(() => r.controller.grantConsent(OWNER, { version: 99 })), { code: 'consent_version', status: 400 });
  const granted = r.controller.grantConsent(OWNER, { version: 1 });
  assert.equal(granted.consent, true);
  assert.equal(r.kinds('computer.consent.granted')[0].details.statement, sha256Hex(CONSENT_STATEMENT));
  assert.equal(r.state.read().consent.by, OWNER.session);
  assert.equal(r.controller.status(OWNER).consent.granted, true);

  const started = r.controller.startMandate(OWNER, { task: 'Tidy the note' });
  assert.equal(r.controller.status(OWNER).mandate.id, started.mandate);
  assert.equal(r.state.read().mandate.state, 'active');
  assert.equal(JSON.stringify(r.state.read()).includes('Tidy the note'), false, 'the task text is never stored');
  await settle();
  await r.controller.revokeConsent(OWNER);
  assert.deepEqual(r.ended(), ['revoked']);
  assert.equal(r.controller.status(OWNER).mandate, null);
  assert.equal(r.state.read().consent, null);
  assert.equal(r.state.read().mandate.endReason, 'revoked');
  assert.equal(r.brains.requests.length, 1);
  assert.deepEqual(refusal(() => r.controller.startMandate(OWNER, { task: 'Again' })), { code: 'consent_missing', status: 409 });
});

test('a mandate takes a valid task and offered actions only, one at a time', async () => {
  const r = rig();
  r.controller.grantConsent(OWNER, { version: 1 });
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: '' })).code, 'mandate_invalid');
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: 'x'.repeat(2001) })).code, 'mandate_invalid');
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: 'Go', extra: 1 })).code, 'mandate_invalid');
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: 'Go', actions: ['app.open'] })).code, 'mandate_invalid', 'no app may be opened without a configured list');
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: 'Go', actions: ['shell.run'] })).code, 'mandate_invalid');
  const m = r.controller.startMandate(OWNER, { task: 'Go', actions: ['screen.look'] });
  assert.deepEqual(m.actions, ['screen.look']);
  assert.deepEqual(refusal(() => r.controller.startMandate(OWNER, { task: 'Second' })), { code: 'mandate_running', status: 409 });
  await r.controller.stop(OWNER);
});

test('mandate expiry: it ends by itself after 120 s, aborting the model request', async () => {
  const r = rig();
  r.controller.grantConsent(OWNER, { version: 1 });
  const m = r.controller.startMandate(OWNER, { task: 'Look around' });
  assert.equal(Date.parse(m.expiresAt) - r.clock.now(), 120_000);
  await settle();
  assert.equal(r.brains.requests.length, 1, 'the model is thinking');
  r.clock.advance(119_999);
  await settle();
  assert.equal(r.controller.status(OWNER).mandate.remainingS, 1);
  r.clock.advance(1);
  await settle();
  assert.deepEqual(r.ended(), ['expired']);
  assert.equal(r.controller.status(OWNER).mandate, null);
  assert.equal(r.state.read().mandate.endReason, 'expired');
});

test('active extension: only the mandate owner extends, and never beyond the mandate length from now', async () => {
  const r = rig({ settings: { mandateS: 90 } });
  r.controller.grantConsent(OWNER, { version: 1 });
  const m = r.controller.startMandate(OWNER, { task: 'Look around' });
  assert.equal(Date.parse(m.expiresAt) - r.clock.now(), 90_000);
  r.clock.advance(80_000);
  assert.deepEqual(refusal(() => r.controller.extend(SECOND_OWNER, { mandate: m.mandate })), { code: 'not_mandate_owner', status: 403 });
  assert.deepEqual(refusal(() => r.controller.extend(OWNER, { mandate: 'other' })), { code: 'mandate_not_running', status: 409 });
  const first = r.controller.extend(OWNER, { mandate: m.mandate });
  assert.equal(Date.parse(first.expiresAt) - r.clock.now(), 90_000, 'the full length from now, not added on top');
  const second = r.controller.extend(OWNER, { mandate: m.mandate });
  assert.equal(Date.parse(second.expiresAt) - r.clock.now(), 90_000);
  assert.equal(second.extensions, 2);
  r.clock.advance(89_000);
  await settle();
  assert.deepEqual(r.ended(), [], 'still running after the extension');
  r.clock.advance(1_000);
  await settle();
  assert.deepEqual(r.ended(), ['expired']);
  assert.equal(r.kinds('computer.mandate.extended').length, 2);
  assert.equal(r.kinds('computer.request.refused').filter((x) => x.details.code === 'not_mandate_owner').length, 1);
});

test('hold: with little time left no step starts until the owner extends; then the loop goes on', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const r = rig({
    model: [
      async () => {
        await gate;
        return plan({ do: 'screen.look', why: 'see what is open' });
      },
      done('Looked at the notes app.'),
    ],
  });
  r.controller.grantConsent(OWNER, { version: 1 });
  const m = r.controller.startMandate(OWNER, { task: 'Look around' });
  r.clock.advance(106_000);
  release();
  await settle();
  const status = r.controller.status(OWNER);
  assert.equal(status.mandate.holding, true);
  assert.ok(status.notes.some((n) => n.code === 'extension_needed'));
  assert.equal(r.actor.performed.length, 0, 'nothing ran while holding');
  assert.equal(r.kinds('computer.step')[0].details.outcome, 'held');
  r.controller.extend(OWNER, { mandate: m.mandate });
  await settle();
  assert.deepEqual(r.ended(), ['finished']);
  const second = r.brains.requests[1].messages.at(-1).content;
  assert.match(second, /"status":"held"/);
  assert.equal(r.controller.status(OWNER).notes.at(-1).text, 'Looked at the notes app.');
});

test('stop: any session, never refused, aborts a running step at once and leaves the stop flag', async () => {
  const r = rig({
    scene: { ...DEMO_SCENE, stalls: ['keyboard.type'] },
    model: [plan({ do: 'keyboard.type', text: 'hello', why: 'write the greeting' })],
  });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Write hello in the note' });
  await until(() => r.actor.busy() === 1);
  const stopped = await r.controller.stop(MEMBER);
  assert.equal(stopped.stopped, true);
  assert.ok(stopped.stopMs < 1000, `stopped in ${stopped.stopMs} ms`);
  assert.equal(r.actor.busy(), 0);
  assert.deepEqual(r.ended(), ['stopped']);
  const step = r.kinds('computer.step')[0].details;
  assert.equal(step.outcome, 'aborted');
  assert.equal(step.cls, 'low');
  assert.equal(r.kinds('computer.mandate.ended')[0].actor, `session:${MEMBER.session.slice(0, 8)}`);
  assert.equal(r.controller.status(OWNER).stopped, true);
  assert.equal(r.state.read().halt.by, MEMBER.session);
  // A stop with nothing running still answers and is recorded; every request names what it met.
  assert.deepEqual(await r.controller.stop(MEMBER), { stopped: true, mandate: null, stopMs: 0 });
  assert.deepEqual(r.kinds('computer.stop.requested').map((x) => x.details.met), ['running', 'idle']);
  assert.equal(r.kinds('computer.stop.requested')[0].details.mandate, stopped.mandate);
  // A new mandate is a person's decision: not during the quiet period, and it clears the flag.
  assert.equal(refusal(() => r.controller.startMandate(OWNER, { task: 'Again' })).code, 'actor_busy');
  r.clock.advance(2_001);
  r.controller.startMandate(OWNER, { task: 'Again' });
  assert.equal(r.controller.status(OWNER).stopped, false);
  await r.controller.stop(OWNER);
});

test('stop while the model thinks aborts its request', async () => {
  const r = rig();
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Look around' });
  await settle();
  const res = await r.controller.stop(OWNER);
  await settle();
  assert.equal(typeof res.stopMs, 'number');
  assert.deepEqual(r.ended(), ['stopped']);
  assert.equal(r.brains.requests.length, 1);
});

test('approvals: a high step waits for the mandate owner; others and the quiet period are refused', async () => {
  const r = rig({
    model: [
      plan({ do: 'screen.look', why: 'see the note' }, { do: 'keyboard.type', text: 'Hello there', why: 'write a greeting' }),
      done('Wrote a greeting.'),
    ],
  });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Write a short greeting in the note' });
  await until(() => r.controller.status(OWNER).approval !== null);
  const mine = r.controller.status(OWNER).approval;
  assert.deepEqual(mine.reasons, ['text_not_from_task']);
  assert.equal(mine.preview.text, 'Hello there');
  assert.equal(mine.preview.app, 'org.example.notes');
  assert.equal(r.controller.status(SECOND_OWNER).approval.preview, undefined, 'the preview is for the mandate owner only');
  assert.equal(r.kinds('computer.approval.asked').length, 1);

  assert.deepEqual(refusal(() => r.controller.decide(SECOND_OWNER, mine.id, { decision: 'allow' })), { code: 'not_mandate_owner', status: 403 });
  assert.deepEqual(refusal(() => r.controller.decide(MEMBER, mine.id, { decision: 'allow' })), { code: 'not_mandate_owner', status: 403 });
  assert.deepEqual(refusal(() => r.controller.decide(OWNER, 'nope', { decision: 'allow' })), { code: 'approval_not_found', status: 404 });
  assert.deepEqual(refusal(() => r.controller.decide(OWNER, mine.id, { decision: 'maybe' })), { code: 'decision_invalid', status: 400 });
  // The look just ran: right now an approval could be the actor's own click.
  assert.deepEqual(refusal(() => r.controller.decide(OWNER, mine.id, { decision: 'allow' })), { code: 'actor_busy', status: 409 });
  assert.equal(refusal(() => r.controller.extend(OWNER, { mandate: r.controller.status(OWNER).mandate.id })).code, 'actor_busy');
  assert.equal(refusal(() => r.controller.grantConsent(OWNER, { version: 1 })).code, 'actor_busy');
  assert.equal(r.actor.performed.filter((p) => p.action === 'keyboard.type').length, 0);

  r.clock.advance(2_001);
  assert.deepEqual(r.controller.decide(OWNER, mine.id, { decision: 'allow' }), { approval: mine.id, decision: 'allow' });
  await until(() => r.ended().length === 1);
  assert.deepEqual(r.ended(), ['finished']);
  const note = r.actor.scene().elements.find((e) => e.label === 'Note text');
  assert.equal(note.value, 'Hello there');
  const steps = r.kinds('computer.step').map((s) => s.details);
  assert.deepEqual(steps.map((s) => [s.action, s.cls, s.outcome]), [['screen.look', 'read', 'done'], ['keyboard.type', 'high', 'done']]);
  assert.equal(steps[1].typedChars, 11);
  assert.equal(JSON.stringify(r.records).includes('Hello there'), false, 'typed text never reaches the audit chain');
  assert.equal(r.kinds('computer.approval.decided')[0].details.decision, 'allow');
  assert.equal(r.kinds('computer.request.refused').filter((x) => x.subject === 'approval').length, 5);
  assert.equal(r.kinds('computer.request.refused').length, 7);
});

test('approvals: a denial or an expiry refuses the step, and the mandate ends when nothing ran', async () => {
  const denied = rig({ model: [plan({ do: 'keyboard.type', text: 'Not in the task', why: 'write it' })] });
  denied.controller.grantConsent(OWNER, { version: 1 });
  denied.controller.startMandate(OWNER, { task: 'Write the note' });
  await until(() => denied.controller.status(OWNER).approval !== null);
  denied.controller.decide(OWNER, denied.controller.status(OWNER).approval.id, { decision: 'deny' });
  await until(() => denied.ended().length === 1);
  assert.deepEqual(denied.ended(), ['finished']);
  assert.ok(denied.kinds('computer.step')[0].details.reasons.includes('approval_denied'));
  assert.equal(denied.actor.performed.length, 0);
  assert.ok(denied.controller.status(OWNER).notes.some((n) => n.code === 'nothing_allowed'));

  const lapsed = rig({ model: [plan({ do: 'keyboard.type', text: 'Not in the task', why: 'write it' })], settings: { approvalS: 30 } });
  lapsed.controller.grantConsent(OWNER, { version: 1 });
  lapsed.controller.startMandate(OWNER, { task: 'Write the note' });
  await until(() => lapsed.controller.status(OWNER).approval !== null);
  const id = lapsed.controller.status(OWNER).approval.id;
  lapsed.clock.advance(30_000);
  await settle();
  assert.equal(lapsed.kinds('computer.approval.lapsed').length, 1);
  assert.ok(lapsed.kinds('computer.step')[0].details.reasons.includes('approval_expired'));
  assert.equal(refusal(() => lapsed.controller.decide(OWNER, id, { decision: 'allow' })).code, 'approval_not_found');
  assert.equal(lapsed.actor.performed.length, 0);
});

test('approvals: a target that changed after the approval voids it', async () => {
  const r = rig({ model: [plan({ do: 'pointer.click', at: [1196, 752], why: 'clear the note' })] });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Clear the note' });
  await until(() => r.controller.status(OWNER).approval !== null);
  const approval = r.controller.status(OWNER).approval;
  assert.equal(approval.preview.label, 'Delete note');
  assert.ok(approval.reasons.includes('risky_target'));
  const scene = r.actor.scene();
  scene.elements = scene.elements.map((e) => (e.label === 'Delete note' ? { ...e, label: 'Delete all notes' } : e));
  r.actor.setScene(scene);
  r.controller.decide(OWNER, approval.id, { decision: 'allow' });
  await until(() => r.ended().length === 1);
  assert.equal(r.actor.performed.length, 0, 'the click never happened');
  assert.ok(r.kinds('computer.step')[0].details.reasons.includes('target_changed'));
});

test('forbidden steps never reach the actor and end the turn; the rest is skipped and recorded', async () => {
  const r = rig({
    scene: { ...DEMO_SCENE, elements: [{ role: 'password', label: 'Password', box: { x: 0, y: 0, w: 200, h: 30 }, focused: true }] },
    model: [plan({ do: 'keyboard.type', text: 'hunter2', why: 'sign in' }, { do: 'keyboard.press', key: 'enter', why: 'confirm' })],
  });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Sign in with hunter2' });
  await until(() => r.ended().length === 1);
  const steps = r.kinds('computer.step').map((s) => s.details);
  assert.deepEqual(steps.map((s) => [s.action, s.cls, s.outcome, s.reasons[0]]), [
    ['keyboard.type', 'forbidden', 'refused', 'field_secret'],
    ['keyboard.press', 'low', 'skipped', 'earlier_step'],
  ]);
  assert.equal(r.actor.performed.length, 0);
  assert.ok(r.controller.status(OWNER).notes.some((n) => n.code === 'field_secret'));
});

test('the screen goes to local models unless the owner marks the mandate shareable; a template answer ends it', async () => {
  const r = rig({ model: [done('Nothing to do.'), { text: 'No model may take this.', source: 'template', notice: 'no_brain_for_class', brain: 'none', locality: 'none' }] });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Look' });
  await until(() => r.ended().length === 1);
  assert.equal(r.brains.requests[0].dataClass, 'sensitive');
  r.clock.advance(2_001);
  r.controller.startMandate(OWNER, { task: 'Look', shareable: true });
  await until(() => r.ended().length === 2);
  assert.equal(r.brains.requests[1].dataClass, 'personal');
  assert.deepEqual(r.ended(), ['finished', 'failed']);
  assert.ok(r.controller.status(OWNER).notes.some((n) => n.code === 'no_brain_for_class'));
  assert.deepEqual(r.kinds('computer.turn').map((t) => t.details.source), ['model', 'template']);
});

test('an unreadable plan is answered once; a second one in a row ends the mandate', async () => {
  const r = rig({ model: ['I will now click the button.', 'Still prose.'] });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Look' });
  await until(() => r.ended().length === 1);
  assert.deepEqual(r.ended(), ['failed']);
  assert.match(r.brains.requests[1].messages.at(-1).content, /plan_not_json/);
  assert.ok(r.controller.status(OWNER).notes.some((n) => n.code === 'plan_unreadable'));
});

test('a restart ends the mandate that was running; consent and the stop flag survive', async () => {
  const store = new Map();
  // The stop flag is set by a stop, which also ends that mandate; the flag outlives the process.
  const first = rig({ store });
  first.controller.grantConsent(OWNER, { version: 1 });
  first.controller.startMandate(OWNER, { task: 'Look' });
  await settle();
  await first.controller.stop(MEMBER);
  assert.equal(first.controller.status(OWNER).stopped, true);
  const second = rig({ store });
  second.controller.afterRestart();
  assert.equal(second.controller.status(OWNER).stopped, true, 'the stop flag holds after the restart');
  assert.equal(second.state.read().halt.by, MEMBER.session);
  assert.deepEqual(second.ended(), [], 'the stopped mandate had ended already');
  assert.equal(second.controller.status(OWNER).consent.granted, true);

  // A new mandate clears the flag; the process goes away without ending it.
  const m = second.controller.startMandate(OWNER, { task: 'Look again' });
  assert.equal(second.controller.status(OWNER).stopped, false);
  const third = rig({ store });
  third.controller.afterRestart();
  assert.deepEqual(third.ended(), ['restart']);
  assert.equal(third.kinds('computer.mandate.ended')[0].details.mandate, m.mandate);
  assert.equal(third.state.read().mandate.state, 'ended');
  assert.equal(third.controller.status(OWNER).consent.granted, true);
  assert.equal(third.controller.status(OWNER).stopped, false);
  third.controller.afterRestart();
  assert.equal(third.ended().length, 1, 'only once');
  await second.controller.stop(OWNER);
});

test('hints and model summaries are for owner sessions and the mandate owner; other members see the state only', async () => {
  const r = rig({ model: [done('Typed the word marmalade into the field titled Private.'), done('Looked at the screen.')] });
  r.controller.grantConsent(OWNER, { version: 1 });
  r.controller.startMandate(OWNER, { task: 'Look' });
  await until(() => r.ended().length === 1);
  assert.equal(r.controller.status(OWNER).notes.at(-1).text, 'Typed the word marmalade into the field titled Private.');
  assert.equal(r.controller.status(SECOND_OWNER).notes.at(-1).kind, 'model', 'every owner session reads them');
  const seen = r.controller.status(MEMBER);
  assert.deepEqual(seen.notes, []);
  assert.equal(JSON.stringify(seen).includes('marmalade'), false);
  assert.equal(seen.consent.granted, true, 'the state itself stays visible');
  assert.equal(seen.mandate, null);
  assert.equal(r.controller.journal().notes.at(-1).text, 'Typed the word marmalade into the field titled Private.');

  // The controller's own rule: whoever started a mandate reads its notes, and only those.
  r.clock.advance(2_001);
  r.controller.startMandate(MEMBER, { task: 'Look' });
  await until(() => r.ended().length === 2);
  const own = r.controller.status(MEMBER).notes;
  assert.deepEqual(own.map((n) => n.text), ['Looked at the screen.']);
  assert.equal(r.controller.status(OWNER).notes.length, 2);
});

test('a stop that meets a mandate already ending is recorded with the end it met, and waits for the standstill', async () => {
  for (const cause of ['revoked', 'expired']) {
    // Typing that ignores the abort until released, so the end has to wait for it.
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    let typing = 0;
    const r = rig({
      model: [plan({ do: 'keyboard.type', text: 'hello', why: 'write the greeting' })],
      wrap: (actor) => ({
        ...actor,
        async typePiece(o) {
          typing += 1;
          await held;
          return actor.typePiece(o);
        },
      }),
    });
    r.controller.grantConsent(OWNER, { version: 1 });
    const m = r.controller.startMandate(OWNER, { task: 'Write hello in the note' });
    await until(() => typing === 1);
    const ending = cause === 'revoked' ? r.controller.revokeConsent(OWNER) : Promise.resolve(r.clock.advance(120_000));
    assert.equal(r.controller.current()?.closed, true, `${cause}: the end is under way`);
    const stopping = r.controller.stop(MEMBER);
    let answered = false;
    stopping.then(() => (answered = true));
    await settle();
    assert.equal(answered, false, `${cause}: the stop answers after the standstill`);
    release();
    const [, stopped] = await Promise.all([ending, stopping]);
    assert.deepEqual(r.ended(), [cause]);
    const requests = r.kinds('computer.stop.requested');
    assert.equal(requests.length, 1, `${cause}: the stop request is recorded`);
    assert.deepEqual(requests[0].details, { mandate: m.mandate, met: 'ending', ending: cause });
    assert.equal(requests[0].actor, `session:${MEMBER.session.slice(0, 8)}`);
    assert.equal(stopped.mandate, m.mandate);
    assert.equal(r.state.read().halt.by, MEMBER.session);
    assert.equal(r.controller.current(), null);
  }
});

test('a typing step cut short records the characters actually typed', async () => {
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // 40 characters: pieces of 16, 16 and 8
  /** What happens right after the first piece, and the outcome and code it leads to. */
  const cases = [
    ['target_moved', (r) => {
      const scene = r.actor.scene();
      scene.elements = scene.elements.map((e) => (e.label === 'Note text' ? { ...e, label: 'Other field' } : e));
      r.actor.setScene(scene);
    }, 'failed'],
    ['extension_needed', (r) => r.clock.advance(106_000), 'aborted'],
    ['aborted', (r) => {
      r.stopping = r.controller.stop(MEMBER);
    }, 'aborted'],
  ];
  for (const [code, disturb, outcome] of cases) {
    let pieces = 0;
    /** @type {any} */
    let r;
    r = rig({
      model: [plan({ do: 'keyboard.type', text, why: 'write the code' })],
      wrap: (actor) => ({
        ...actor,
        async typePiece(o) {
          const result = await actor.typePiece(o);
          pieces += 1;
          if (pieces === 1) disturb(r);
          return result;
        },
      }),
    });
    r.controller.grantConsent(OWNER, { version: 1 });
    r.controller.startMandate(OWNER, { task: `Write ${text} in the note` });
    await until(() => r.kinds('computer.step').length === 1);
    const step = r.kinds('computer.step')[0].details;
    assert.equal(step.cls, 'low', code);
    assert.equal(step.outcome, outcome, code);
    assert.ok(step.reasons.includes(code), `${code}: ${step.reasons}`);
    assert.equal(step.typedChars, 16, `${code}: one piece of 16 characters was typed, not all 40`);
    assert.equal(r.actor.scene().elements.find((e) => e.role === 'textbox').value, text.slice(0, 16));
    await (r.stopping ?? r.controller.stop(OWNER));
  }
});
