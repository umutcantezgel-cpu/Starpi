// @ts-check
// A small MQTT client that can only listen: it connects to a broker on this machine, subscribes
// to topic filters and hands every message it receives to the caller. It has no way to publish:
// the only packets it ever sends are CONNECT, SUBSCRIBE, the acknowledgements a received message
// asks for (PUBACK, PUBREC, PUBCOMP), PINGREQ and DISCONNECT. Protocol versions 3.1.1 (level 4)
// and 5 (level 5) are spoken; with 5, properties the broker sends are read and skipped.
//
// The connection is watched with the keep-alive interval: a PINGREQ goes out when nothing was sent
// for that long, and a broker that does not answer within it is treated as gone. A lost connection
// is opened again after a pause that doubles up to a minute. Written from the protocol
// specifications (OASIS MQTT 3.1.1 and 5.0) without a library.
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

export const PACKET = Object.freeze({ CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, PUBREC: 5, PUBREL: 6, PUBCOMP: 7, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 });
/** Largest packet the client accepts (a reading is small; anything bigger is a mistake or an attack). */
export const MAX_PACKET = 256 * 1024;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;

/** @param {number} n */
export function encodeLength(n) {
  /** @type {number[]} */
  const out = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Buffer.from(out);
}

/**
 * Reads a variable byte integer.
 * @param {Buffer} buf
 * @param {number} at
 * @returns {{ value: number, size: number } | null}  null when the buffer ends inside it
 */
export function decodeLength(buf, at) {
  let value = 0;
  let factor = 1;
  for (let i = 0; i < 4; i += 1) {
    if (at + i >= buf.length) return null;
    const byte = buf[at + i];
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
    factor *= 128;
  }
  throw new Error('malformed remaining length');
}

/** @param {string} text */
export const encodeString = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  return Buffer.concat([len, bytes]);
};

/** @param {number} type @param {number} flags @param {Buffer} body */
export const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);

/**
 * Whether a topic matches a filter with `+` (one level) and `#` (the rest).
 * @param {string} filter
 * @param {string} topic
 */
export function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  // Topics starting with $ are never matched by a filter that starts with a wildcard.
  if (topic.startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** A filter as a subscription accepts it. @param {unknown} filter */
export function isTopicFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0 || Buffer.byteLength(filter) > 1024 || filter.includes('\u0000')) return false;
  const levels = filter.split('/');
  return levels.every((level, i) => (level.includes('#') ? level === '#' && i === levels.length - 1 : !level.includes('+') || level === '+'));
}

/**
 * Splits a byte stream into MQTT packets.
 * @param {(type: number, flags: number, body: Buffer) => void} onPacket
 */
export function packetReader(onPacket) {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0);
  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const len = decodeLength(pending, 1);
        if (!len) return;
        if (len.value > MAX_PACKET) throw new Error('packet too large');
        const total = 1 + len.size + len.value;
        if (pending.length < total) return;
        const first = pending[0];
        const body = pending.subarray(1 + len.size, total);
        pending = pending.subarray(total);
        onPacket(first >> 4, first & 0x0f, body);
      }
    },
  };
}

/**
 * @typedef {object} SubscriberOptions
 * @property {string} host
 * @property {number} port
 * @property {4 | 5} [protocol]                 default 4 (3.1.1)
 * @property {string} [clientId]                default a random starpi-<hex>
 * @property {number} [keepAliveS]              default 30
 * @property {Array<{ filter: string, qos?: 0 | 1 }>} topics
 * @property {number} [connectTimeoutMs]        default 10 000
 * @property {(topic: string, payload: Buffer, info: { retain: boolean, qos: number }) => void} onMessage
 * @property {(state: 'connecting' | 'up' | 'down', detail?: string) => void} [onState]
 * @property {typeof netConnect} [connect]
 */

/**
 * A subscriber that keeps itself connected until stopped.
 * @param {SubscriberOptions} options
 */
export function createMqttSubscriber(options) {
  const protocol = options.protocol ?? 4;
  const keepAliveS = options.keepAliveS ?? 30;
  const clientId = options.clientId ?? `starpi-${randomBytes(6).toString('hex')}`;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const open = options.connect ?? netConnect;
  /** @type {import('node:net').Socket | null} */
  let socket = null;
  /** @type {NodeJS.Timeout | null} */
  let retryTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let pingTimer = null;
  let retryMs = RETRY_MIN_MS;
  let stopped = true;
  let nextPacketId = 1;
  let lastSent = 0;
  let awaitingPong = 0;
  /** @type {'connecting' | 'up' | 'down'} */
  let state = 'down';
  const stats = { connects: 0, messages: 0, subscribed: /** @type {string[]} */ ([]), refused: /** @type {string[]} */ ([]) };

  /** @param {'connecting' | 'up' | 'down'} next @param {string} [detail] */
  function setState(next, detail) {
    if (state === next && next !== 'down') return;
    state = next;
    options.onState?.(next, detail);
  }

  /** @param {Buffer} bytes */
  function send(bytes) {
    if (!socket || socket.destroyed) return;
    socket.write(bytes);
    lastSent = Date.now();
  }

  /** Properties of a version 5 packet: their length and how many bytes they take. @param {Buffer} body @param {number} at */
  function skipProperties(body, at) {
    if (protocol !== 5) return at;
    const len = decodeLength(body, at);
    if (!len) throw new Error('cut-off properties');
    return at + len.size + len.value;
  }

  function connectPacket() {
    const flags = 0x02; // clean session / clean start
    const keepAlive = Buffer.alloc(2);
    keepAlive.writeUInt16BE(keepAliveS);
    const parts = [encodeString('MQTT'), Buffer.from([protocol, flags]), keepAlive];
    if (protocol === 5) parts.push(Buffer.from([0])); // no properties
    parts.push(encodeString(clientId));
    return packet(PACKET.CONNECT, 0, Buffer.concat(parts));
  }

  function subscribePacket() {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(nextPacketId);
    nextPacketId = (nextPacketId % 65535) + 1;
    const parts = [id];
    if (protocol === 5) parts.push(Buffer.from([0]));
    for (const t of options.topics) parts.push(encodeString(t.filter), Buffer.from([t.qos ?? 0]));
    return packet(PACKET.SUBSCRIBE, 0x02, Buffer.concat(parts));
  }

  /** @param {number} type @param {number} flags @param {Buffer} body */
  function onPacket(type, flags, body) {
    switch (type) {
      case PACKET.CONNACK: {
        const code = body[1];
        if (code !== 0) {
          drop(`the broker refused the connection (code ${code})`);
          return;
        }
        stats.connects += 1;
        retryMs = RETRY_MIN_MS;
        send(subscribePacket());
        return;
      }
      case PACKET.SUBACK: {
        let at = skipProperties(body, 2);
        const granted = [];
        const refused = [];
        for (const t of options.topics) {
          const code = body[at];
          at += 1;
          if (code === undefined || code >= 0x80) refused.push(t.filter);
          else granted.push(t.filter);
        }
        stats.subscribed = granted;
        stats.refused = refused;
        if (granted.length === 0) {
          drop('the broker refused every subscription');
          return;
        }
        setState('up', refused.length > 0 ? `refused: ${refused.join(', ')}` : undefined);
        return;
      }
      case PACKET.PUBLISH: {
        const qos = (flags >> 1) & 0x03;
        const retain = (flags & 0x01) === 1;
        const topicLen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLen).toString('utf8');
        let at = 2 + topicLen;
        let id = 0;
        if (qos > 0) {
          id = body.readUInt16BE(at);
          at += 2;
        }
        at = skipProperties(body, at);
        const payload = body.subarray(at);
        const ack = Buffer.alloc(2);
        ack.writeUInt16BE(id);
        // Acknowledgements only: the broker's message is confirmed, nothing is published.
        if (qos === 1) send(packet(PACKET.PUBACK, 0, ack));
        else if (qos === 2) send(packet(PACKET.PUBREC, 0, ack));
        stats.messages += 1;
        options.onMessage(topic, Buffer.from(payload), { retain, qos });
        return;
      }
      case PACKET.PUBREL: {
        send(packet(PACKET.PUBCOMP, 0, body.subarray(0, 2)));
        return;
      }
      case PACKET.PINGRESP:
        awaitingPong = 0;
        return;
      case PACKET.DISCONNECT:
        drop('the broker closed the session');
        return;
      default:
        // Anything else (a broker never sends SUBSCRIBE or CONNECT) is ignored.
        return;
    }
  }

  /** @param {string} detail */
  function drop(detail) {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    const s = socket;
    socket = null;
    s?.destroy();
    setState('down', detail);
    if (!stopped && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        dial();
      }, retryMs);
      retryTimer.unref?.();
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }

  function dial() {
    if (stopped) return;
    setState('connecting');
    const s = open({ host: options.host, port: options.port });
    socket = s;
    s.setNoDelay(true);
    const reader = packetReader(onPacket);
    const timeout = setTimeout(() => {
      if (state !== 'up') drop('the broker did not answer in time');
    }, connectTimeoutMs);
    timeout.unref?.();
    s.once('connect', () => {
      awaitingPong = 0;
      send(connectPacket());
      pingTimer = setInterval(() => {
        if (awaitingPong > 0 && Date.now() - awaitingPong > keepAliveS * 1000) {
          drop('the broker stopped answering');
          return;
        }
        if (Date.now() - lastSent >= keepAliveS * 1000 * 0.75 && awaitingPong === 0) {
          awaitingPong = Date.now();
          send(packet(PACKET.PINGREQ, 0, Buffer.alloc(0)));
        }
      }, Math.max(250, (keepAliveS * 1000) / 4));
      pingTimer.unref?.();
    });
    s.on('data', (chunk) => {
      if (socket !== s) return;
      try {
        reader.push(/** @type {Buffer} */ (chunk));
      } catch (err) {
        drop(`a malformed packet: ${/** @type {Error} */ (err).message}`);
      }
    });
    s.on('error', (err) => {
      if (socket === s) drop(/** @type {any} */ (err).code ?? 'connection failed');
    });
    s.on('close', () => {
      clearTimeout(timeout);
      if (socket === s) drop('the connection closed');
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      dial();
    },
    /** Closes the connection politely and stops reconnecting. */
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      const s = socket;
      socket = null;
      if (s && !s.destroyed) {
        s.end(packet(PACKET.DISCONNECT, 0, Buffer.alloc(0)));
        s.destroySoon?.();
        setTimeout(() => s.destroy(), 200).unref?.();
      }
      state = 'down';
    },
    state: () => state,
    stats: () => ({ ...stats, state, clientId }),
  };
}
