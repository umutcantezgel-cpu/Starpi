// Feeds: CSV imports and an MQTT subscription against a small broker simulator, as feed.sample
// and feed.health events; the client only listens.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { tempDir } from './helpers.mjs';
import { client, eventually, startModules } from './module-helpers.mjs';
import { readTime, samplesFromCsv } from '../src/feeds/csv.js';
import { createMqttSubscriber, decodeLength, encodeLength, packetReader, topicMatches } from '../src/feeds/mqtt.js';
import { seriesFor } from '../src/feeds/module.js';

/** @param {string} text */
const str = (text) => {
  const b = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
};
/** @param {number} first @param {Buffer} body */
const frame = (first, body) => Buffer.concat([Buffer.from([first]), encodeLength(body.length), body]);

/**
 * A broker that accepts every client, grants every subscription and publishes what the test asks
 * it to. It records the type of every packet a client sends.
 */
async function brokerSim() {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const seen = /** @type {Array<{ type: number, protocol?: number, filters?: string[] }>} */ ([]);
  /** @type {Array<(s: import('node:net').Socket, protocol: number) => void>} */
  const onSubscribed = [];
  let protocolOf = new Map();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const reader = packetReader((type, flags, body) => {
      if (type === 1) {
        const nameLen = body.readUInt16BE(0);
        const protocol = body[2 + nameLen];
        protocolOf.set(socket, protocol);
        seen.push({ type, protocol });
        socket.write(frame(0x20, protocol === 5 ? Buffer.from([0, 0, 0]) : Buffer.from([0, 0])));
        return;
      }
      const protocol = protocolOf.get(socket);
      if (type === 8) {
        const id = body.subarray(0, 2);
        let at = 2;
        if (protocol === 5) at += 1 + body[2];
        /** @type {string[]} */
        const filters = [];
        while (at < body.length) {
          const len = body.readUInt16BE(at);
          filters.push(body.subarray(at + 2, at + 2 + len).toString('utf8'));
          at += 2 + len + 1;
        }
        seen.push({ type, filters });
        const codes = Buffer.from(filters.map(() => 1));
        socket.write(frame(0x90, Buffer.concat([id, protocol === 5 ? Buffer.from([0]) : Buffer.alloc(0), codes])));
        for (const fn of onSubscribed) fn(socket, protocol);
        return;
      }
      seen.push({ type });
      if (type === 12) socket.write(Buffer.from([0xd0, 0]));
    });
    socket.on('data', (chunk) => reader.push(chunk));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port,
    seen,
    onSubscribed,
    /**
     * Publishes to every client.
     * @param {string} topic
     * @param {string} payload
     * @param {{ qos?: number, retain?: boolean, id?: number }} [options]
     */
    publish(topic, payload, { qos = 0, retain = false, id = 7 } = {}) {
      for (const s of sockets) {
        const protocol = protocolOf.get(s);
        const parts = [str(topic)];
        if (qos > 0) parts.push(Buffer.from([id >> 8, id & 0xff]));
        if (protocol === 5) parts.push(Buffer.from([0]));
        parts.push(Buffer.from(payload, 'utf8'));
        s.write(frame(0x30 | (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts)));
      }
    },
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve(undefined));
    }),
  };
}

test('MQTT pieces: lengths, topic filters, series names', () => {
  for (const n of [0, 127, 128, 16_383, 16_384, 2_097_151, 268_435_455]) assert.equal(decodeLength(encodeLength(n), 0)?.value, n);
  assert.equal(decodeLength(Buffer.from([0x80]), 0), null);
  assert.equal(topicMatches('home/+/temperature', 'home/kitchen/temperature'), true);
  assert.equal(topicMatches('home/#', 'home/a/b/c'), true);
  assert.equal(topicMatches('home/+', 'home/a/b'), false);
  assert.equal(topicMatches('#', '$SYS/load'), false);
  assert.equal(seriesFor('{2}.temperature', 'home/Living Room/temperature'), 'living_room.temperature');
  assert.equal(seriesFor('{9}', 'a/b'), null);
});

test('CSV readings: long and wide layouts, local times in the zone, problems by line', () => {
  assert.equal(readTime('2026-10-18 09:30', 'Asia/Tokyo'), '2026-10-18T00:30:00.000Z');
  assert.equal(readTime('2026-10-18T09:30:00+02:00', 'UTC'), '2026-10-18T07:30:00.000Z');
  assert.equal(readTime('18.10.2026', 'UTC'), null);
  const long = samplesFromCsv('series,value,unit,ts_source,quality\nkitchen.temperature,21.5,°C,2026-10-18T07:00:00Z,good\nkitchen.temperature,"21,7",°C,2026-10-18T07:05:00Z,\nkitchen.temperature,warm,°C,2026-10-18T07:10:00Z,good\n', { sourceId: 'meter', timeZone: 'UTC', now: 0 });
  assert.equal(long.layout, 'long');
  assert.deepEqual(long.samples.map((s) => s.value), [21.5, 21.7]);
  assert.deepEqual(long.problems, [{ line: 4, problem: 'the value is not a number' }]);
  const wide = samplesFromCsv('time;power.total [W];power.heater [W]\n2026-10-18 08:00;512;120\n2026-10-18 08:15;498;\n', { sourceId: 'meter', timeZone: 'Europe/Paris', now: 0 });
  assert.equal(wide.layout, 'wide');
  assert.equal(wide.samples.length, 3);
  assert.deepEqual(wide.samples[0], { source_id: 'meter', series: 'power.total', value: 512, unit: 'W', ts_source: '2026-10-18T06:00:00.000Z', quality: 'good' });
  const foreign = samplesFromCsv('source_id,series,value\nother,a.b,1\n', { sourceId: 'meter', timeZone: 'UTC', now: 0 });
  assert.equal(foreign.samples.length, 0, 'a row may not speak for another source');
  assert.equal(samplesFromCsv('just one line', { sourceId: 'meter', timeZone: 'UTC', now: 0 }).problems.length, 1);
});

test('CSV import: readings become feed.sample events once, latest readings and health follow', async (t) => {
  const { dir, cleanup } = tempDir();
  const raw = { timeZone: 'UTC', modules: { feeds: { sources: [{ id: 'power-meter', type: 'csv', dataClass: 'public' }] } } };
  const { companion } = await startModules(dir, { only: ['feeds'], raw });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion, { role: 'member' });
  const csv = 'ts_source,power.total [W]\n2026-10-18T08:00:00Z,512\n2026-10-18T08:15:00Z,498\n2026-10-18T08:30:00Z,lots\n';
  const first = await c.request('POST', '/v1/feeds/import?source=power-meter', { raw: csv, type: 'text/csv' });
  assert.equal(first.status, 200);
  assert.equal(first.json().stored, 2);
  assert.equal(first.json().problems.length, 1);
  const again = (await c.request('POST', '/v1/feeds/import?source=power-meter', { raw: csv, type: 'text/csv' })).json();
  assert.equal(again.stored, 0);
  assert.equal(again.duplicates, 2, 'the same reading is stored once');
  assert.equal((await c.request('POST', '/v1/feeds/import?source=unknown', { raw: csv, type: 'text/csv' })).status, 404);
  const latest = (await c.get('/v1/feeds/latest')).json().readings;
  assert.deepEqual(latest.map((/** @type {any} */ r) => [r.series, r.value]), [['power.total', 498]]);
  const events = companion.installation.store.read({ types: ['feed.sample', 'feed.health'] });
  assert.equal(events.filter((e) => e.type === 'feed.sample').length, 2);
  assert.deepEqual(events.filter((e) => e.type === 'feed.health').map((e) => e.body.state), ['up']);
  const projected = /** @type {any[]} */ (companion.installation.store.db.prepare('SELECT series, value FROM feed_latest').all());
  assert.deepEqual(projected.map((r) => [r.series, r.value]), [['power.total', 498]]);
});

for (const protocol of /** @type {const} */ ([4, 5])) {
  test(`MQTT ${protocol === 4 ? '3.1.1' : '5'}: subscribe only, readings and health from a local broker`, async (t) => {
    const broker = await brokerSim();
    broker.onSubscribed.push(() => {
      setTimeout(() => {
        broker.publish('home/kitchen/temperature', '21.5');
        broker.publish('home/garage/temperature', JSON.stringify({ temp: 9.25, ts: '2026-10-18T07:00:00Z', q: 'uncertain' }), { qos: 1, id: 3 });
        broker.publish('home/attic/temperature', 'not a number');
        broker.publish('home/cellar/temperature', '12', { retain: true });
      }, 20);
    });
    const { dir, cleanup } = tempDir();
    const raw = {
      modules: {
        feeds: {
          sources: [{
            id: 'home-sensors',
            type: 'mqtt',
            url: `mqtt://127.0.0.1:${broker.port}`,
            protocol,
            topics: [
              { filter: 'home/garage/temperature', series: 'garage.temperature', unit: '°C', value: 'temp', time: 'ts', quality: 'q', qos: 1 },
              { filter: 'home/+/temperature', series: '{2}.temperature', unit: '°C' },
            ],
            minIntervalMs: 0,
          }],
        },
      },
    };
    const { companion, hub } = await startModules(dir, { only: ['notify', 'feeds'], raw });
    t.after(async () => {
      await companion.stop();
      await broker.close();
      cleanup();
    });
    const c = await client(companion);
    const readings = await eventually(async () => {
      const r = (await c.get('/v1/feeds/latest')).json().readings;
      return r.length >= 3 ? r : null;
    });
    const bySeries = Object.fromEntries(readings.map((/** @type {any} */ r) => [r.series, r]));
    assert.equal(bySeries['kitchen.temperature'].value, 21.5);
    assert.equal(bySeries['kitchen.temperature'].quality, 'good');
    assert.equal(bySeries['garage.temperature'].value, 9.25);
    assert.equal(bySeries['garage.temperature'].ts_source, '2026-10-18T07:00:00.000Z');
    assert.equal(bySeries['garage.temperature'].quality, 'uncertain');
    assert.equal(bySeries['cellar.temperature'].quality, 'uncertain', 'a retained value of unknown age');
    assert.equal(bySeries['attic.temperature'], undefined);
    const status = (await c.get('/v1/feeds')).json().sources[0];
    assert.equal(status.state, 'up');
    assert.equal(status.problems, 1);
    assert.deepEqual(status.mqtt.subscribed, ['home/garage/temperature', 'home/+/temperature']);

    const types = new Set(broker.seen.map((p) => p.type));
    assert.equal(types.has(3), false, 'the client never publishes');
    assert.ok(types.has(4), 'the QoS 1 message was acknowledged');
    assert.equal(broker.seen[0].protocol, protocol);

    // The broker goes away: the source is down, the inbox says so, and it comes back.
    broker.dropClients();
    await eventually(async () => (await c.get('/v1/feeds')).json().sources[0].state === 'down');
    assert.ok((await c.get('/v1/notify')).json().notifications.some((/** @type {any} */ n) => n.kind === 'feed_down' && n.ref === 'home-sensors'));
    await eventually(async () => (await c.get('/v1/feeds')).json().sources[0].state === 'up', { timeoutMs: 8000 });
    const health = companion.installation.store.read({ types: ['feed.health'] }).map((e) => e.body.state);
    assert.deepEqual(health.slice(0, 3), ['up', 'down', 'up']);
    assert.ok(/** @type {any} */ (hub.get('feeds')).relevant('how cold is the garage temperature').some((/** @type {any} */ r) => r.series === 'garage.temperature'));
  });
}

test('MQTT subscriber: a refused connection is retried and reported down', async (t) => {
  const server = createServer((socket) => {
    socket.on('data', () => socket.end(Buffer.from([0x20, 2, 0, 5])));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  /** @type {string[]} */
  const states = [];
  const sub = createMqttSubscriber({ host: '127.0.0.1', port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, topics: [{ filter: 'a/#' }], onMessage: () => {}, onState: (s, d) => states.push(`${s}:${d ?? ''}`) });
  sub.start();
  await eventually(() => states.some((s) => s.startsWith('down:the broker refused')));
  sub.stop();
  assert.equal(sub.state(), 'down');
});
