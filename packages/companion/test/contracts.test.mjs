import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEvent, checkModule, createEventTypes, FEED_EVENT_TYPES, mayReach, roleAllows, strictest } from '../src/contracts/index.js';

test('data classes: secret reaches no model, sensitive only local, personal to cloud only when allowed', () => {
  assert.equal(mayReach('secret', 'local'), false);
  assert.equal(mayReach('secret', 'cloud'), false);
  assert.equal(mayReach('secret', 'none'), true);
  assert.equal(mayReach('sensitive', 'local'), true);
  assert.equal(mayReach('sensitive', 'cloud'), false);
  assert.equal(mayReach('personal', 'cloud'), true);
  assert.equal(mayReach('personal', 'cloud', { personalToCloud: false }), false);
  assert.equal(mayReach('public', 'cloud', { personalToCloud: false }), true);
  assert.equal(strictest('personal', 'sensitive'), 'sensitive');
  assert.equal(strictest('secret', 'public'), 'secret');
});

test('roles: owner covers member, nobody covers only public', () => {
  assert.equal(roleAllows('owner', 'member'), true);
  assert.equal(roleAllows('member', 'owner'), false);
  assert.equal(roleAllows(null, 'public'), true);
  assert.equal(roleAllows(null, 'member'), false);
});

test('events: the envelope and the registered feed body are checked', () => {
  const types = createEventTypes();
  for (const t of FEED_EVENT_TYPES) types.register(t);
  const good = { type: 'feed.sample', source: 'demo-sensor', key: 'a', at: '2026-01-01T00:00:00Z', class: 'public', body: { source_id: 'demo-sensor', series: 'room.temperature', value: 20.5, unit: '°C', ts_source: '2026-01-01T00:00:00Z', quality: 'good' } };
  assert.deepEqual(checkEvent(good, types), []);
  assert.match(checkEvent({ ...good, type: 'feed.unknown' }, types)[0], /not registered/);
  assert.match(checkEvent({ ...good, class: 'internal' }, types)[0], /event.class/);
  assert.ok(checkEvent({ ...good, body: { ...good.body, value: Number.NaN } }, types).some((p) => p.includes('.value')));
  assert.ok(checkEvent({ ...good, body: { ...good.body, quality: 'perfect' } }, types).some((p) => p.includes('.quality')));
  assert.ok(checkEvent({ ...good, extra: 1 }, types).some((p) => p.includes('not a member')));
  assert.throws(() => types.register(FEED_EVENT_TYPES[0]), /registered already/);
});

test('modules: ids, egress entries, routes and functions are checked', () => {
  const ok = { id: 'notes', version: '1.0.0', egress: ['api.example.com:443'], namespaces: ['notes'], routes: [{ method: 'GET', path: '/items/:id', access: 'member', handler: () => ({}) }] };
  assert.deepEqual(checkModule(ok), []);
  assert.ok(checkModule({ ...ok, id: 'Notes' }).length > 0);
  assert.ok(checkModule({ ...ok, egress: ['api.example.com:80'] }).length > 0);
  assert.ok(checkModule({ ...ok, routes: [{ method: 'PATCH', path: 'x', access: 'everyone', handler: 1 }] }).length >= 3);
  assert.ok(checkModule({ ...ok, start: 'yes' }).some((p) => p.includes('start')));
});
