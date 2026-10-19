// The agenda in a configured time zone, its daylight saving rules, reminders in the inbox and the
// inbox's event stream.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualClock } from '../src/lib/clock.js';
import { instantOf, nextRun, ruleProblems } from '../src/agenda/recurrence.js';
import { tempDir } from './helpers.mjs';
import { client, eventually, startModules } from './module-helpers.mjs';

const iso = (/** @type {number | null} */ ms) => (ms === null ? null : new Date(ms).toISOString());

test('recurrence: daily, weekly, monthly and once, in the zone they are planned in', () => {
  const from = Date.UTC(2026, 9, 18, 12, 0); // Sunday 2026-10-18 12:00 UTC
  assert.equal(iso(nextRun({ type: 'daily', time: '09:00' }, from, 'Asia/Tokyo')), '2026-10-19T00:00:00.000Z', '21:00 in Tokyo already, so tomorrow 09:00');
  assert.equal(iso(nextRun({ type: 'daily', time: '09:00' }, from, 'America/New_York')), '2026-10-18T13:00:00.000Z', '08:00 in New York, so today');
  assert.equal(iso(nextRun({ type: 'weekly', days: [3], time: '18:30' }, from, 'UTC')), '2026-10-21T18:30:00.000Z');
  assert.equal(iso(nextRun({ type: 'monthly', day: 'last', time: '08:00' }, from, 'UTC')), '2026-10-31T08:00:00.000Z');
  assert.equal(iso(nextRun({ type: 'monthly', day: 31, time: '08:00' }, Date.UTC(2026, 10, 1), 'UTC')), '2026-11-30T08:00:00.000Z', 'a missing day means the last day');
  assert.equal(iso(nextRun({ type: 'once', date: '2026-10-20', time: '07:15' }, from, 'Australia/Sydney')), '2026-10-19T20:15:00.000Z');
  assert.equal(nextRun({ type: 'once', date: '2026-01-01', time: '07:15' }, from, 'UTC'), null);
  assert.deepEqual(ruleProblems({ type: 'weekly', days: [0, 8], time: '25:00' }).length, 2);
  assert.ok(ruleProblems({ type: 'once', date: '2026-02-30', time: '10:00' }).length > 0);
  assert.ok(ruleProblems({ type: 'daily', time: '10:00', extra: 1 }).length > 0);
});

test('recurrence: a time skipped by the clock moves to the first minute after; a repeated time fires once, first', () => {
  const zone = 'America/New_York';
  // 2026-03-08: 02:00 jumps to 03:00 local (07:00 UTC).
  assert.equal(iso(instantOf({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, zone)), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(nextRun({ type: 'daily', time: '02:30' }, Date.UTC(2026, 2, 7, 12), zone)), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(nextRun({ type: 'daily', time: '02:30' }, Date.UTC(2026, 2, 8, 12), zone)), '2026-03-09T06:30:00.000Z');
  // 2026-11-01: 01:30 local happens at 05:30 and at 06:30 UTC; the first is taken, the second never.
  const first = nextRun({ type: 'daily', time: '01:30' }, Date.UTC(2026, 9, 31, 12), zone);
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextRun({ type: 'daily', time: '01:30' }, /** @type {number} */ (first), zone)), '2026-11-02T06:30:00.000Z');
});

test('agenda in a configured time zone: reminders reach the inbox and its stream on time', async (t) => {
  const clock = manualClock(Date.UTC(2026, 9, 18, 12, 0));
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['notify', 'agenda'], raw: { timeZone: 'Asia/Tokyo' }, options: { clock } });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion);
  const created = await c.post('/v1/agenda', { title: 'Take out the recycling', rule: { type: 'daily', time: '09:00' } });
  assert.equal(created.status, 201);
  const item = created.json().item;
  assert.equal(item.timeZoneUsed, 'Asia/Tokyo');
  assert.equal(item.next, '2026-10-19T00:00:00.000Z');
  assert.equal(item.nextLocal, '2026-10-19 09:00');
  const own = (await c.post('/v1/agenda', { title: 'Call home', rule: { type: 'weekly', days: [1], time: '19:00' }, timeZone: 'America/New_York' })).json().item;
  assert.equal(own.next, '2026-10-19T23:00:00.000Z');
  assert.equal((await c.post('/v1/agenda', { title: 'x', rule: { type: 'daily', time: '9am' } })).status, 400);
  assert.equal((await c.post('/v1/agenda', { title: 'x', rule: { type: 'daily', time: '09:00' }, timeZone: 'Mars/Base' })).status, 400);

  const upcoming = (await c.get('/v1/agenda/upcoming?days=3')).json().occurrences;
  assert.deepEqual(upcoming.map((/** @type {any} */ o) => o.at), ['2026-10-19T00:00:00.000Z', '2026-10-19T23:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z']);

  const stream = c.stream('GET', '/v1/notify/stream', { until: (events) => events.some((e) => e.event === 'notification') });
  await eventually(async () => (await c.get('/v1/status')).status === 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  clock.advance(12 * 3_600_000); // 2026-10-19 00:00 UTC = 09:00 in Tokyo
  const { events } = await stream;
  const hello = events.find((e) => e.event === 'hello');
  assert.equal(hello?.data.latest, 0);
  const note = events.find((e) => e.event === 'notification')?.data;
  assert.equal(note.kind, 'reminder');
  assert.equal(note.ref, item.id);
  assert.equal(note.title, 'Take out the recycling');

  const after = (await c.get(`/v1/agenda/${item.id}`)).json().item;
  assert.equal(after.runs, 1);
  assert.equal(after.next, '2026-10-20T00:00:00.000Z');
  const inbox = (await c.get('/v1/notify?after=0')).json();
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.unread, 1);
  assert.equal((await c.post(`/v1/notify/${note.id}/read`)).json().notification.read, true);
  assert.equal((await c.get('/v1/notify?after=99')).json().reset, true, 'a number beyond the newest starts over');
  assert.equal((await c.del(`/v1/agenda/${own.id}`)).status, 200);
  const records = /** @type {any[]} */ (companion.installation.store.db.prepare("SELECT kind FROM audit_log WHERE kind LIKE 'agenda.%' ORDER BY seq").all());
  assert.deepEqual(records.map((r) => r.kind), ['agenda.added', 'agenda.added', 'agenda.deleted']);
});

test('agenda after a stop: a recent reminder fires late, an old one is reported missed', async (t) => {
  const clock = manualClock(Date.UTC(2026, 9, 18, 6, 0));
  const { dir, cleanup } = tempDir();
  const raw = { timeZone: 'UTC', modules: { agenda: { catchUpMinutes: 45 } } };
  const first = await startModules(dir, { only: ['notify', 'agenda'], raw, options: { clock } });
  const c = await client(first.companion);
  const soon = (await c.post('/v1/agenda', { title: 'Water the herbs', rule: { type: 'once', date: '2026-10-18', time: '07:00' } })).json().item;
  const daily = (await c.post('/v1/agenda', { title: 'Stretch', rule: { type: 'daily', time: '06:30' } })).json().item;
  await first.companion.stop();
  // Back at 07:30: the first reminder is 30 minutes late, the daily one 60 minutes.
  clock.advance(90 * 60_000);
  const second = await startModules(dir, { only: ['notify', 'agenda'], raw, options: { clock } });
  t.after(async () => {
    await second.companion.stop();
    cleanup();
  });
  const c2 = await client(second.companion);
  const notes = (await c2.get('/v1/notify')).json().notifications;
  const kinds = Object.fromEntries(notes.map((/** @type {any} */ n) => [n.ref, n.kind]));
  assert.equal(kinds[soon.id], 'reminder');
  assert.equal(kinds[daily.id], 'reminder_missed');
  const once = (await c2.get(`/v1/agenda/${soon.id}`)).json().item;
  assert.equal(once.active, false, 'a one-time item is done');
  assert.equal(once.runs, 1);
  const again = (await c2.get(`/v1/agenda/${daily.id}`)).json().item;
  assert.equal(again.runs, 0);
  assert.equal(again.next, '2026-10-19T06:30:00.000Z');
});
