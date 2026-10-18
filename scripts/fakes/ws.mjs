// A minimal WebSocket server side (RFC 6455) for the fakes, so they need no dependency: the
// opening handshake, text and binary messages (fragmented ones too), ping/pong and the closing
// handshake. Messages from the client must be masked, as browsers and Node's WebSocket always do;
// the server sends unmasked frames. Enough for a local fake, not a general server.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest message the fake accepts (about 1 minute of 16 kHz audio as base64 JSON is far below). */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {object} FakeSocket
 * @property {(text: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {(fn: (data: string | Buffer, binary: boolean) => void) => void} onMessage
 * @property {(fn: (code: number, reason: string) => void) => void} onClose
 * @property {() => boolean} open
 */

/**
 * Answers an HTTP upgrade request that is not a WebSocket handshake (or is refused).
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {string} text
 */
export function refuseUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * One frame.
 * @param {number} opcode
 * @param {Buffer} payload
 */
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * Completes the handshake of an upgrade request and returns the socket's message interface.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head bytes that arrived with the request
 * @returns {FakeSocket | null} null when the request is not a valid handshake (it was refused)
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !key) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));

  /** @type {Array<(data: string | Buffer, binary: boolean) => void>} */
  const messageFns = [];
  /** @type {Array<(code: number, reason: string) => void>} */
  const closeFns = [];
  let buffer = Buffer.alloc(0);
  /** @type {Buffer[]} */
  let fragments = [];
  let fragmentOpcode = 0;
  let isOpen = true;
  let closeSent = false;

  /** @param {number} code @param {string} reason */
  const finish = (code, reason) => {
    if (!isOpen) return;
    isOpen = false;
    for (const fn of closeFns) fn(code, reason);
  };

  /** @param {number} code @param {string} reason */
  const sendClose = (code, reason) => {
    if (closeSent || socket.destroyed) return;
    closeSent = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    socket.write(frame(0x8, payload));
  };

  const parse = () => {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        at = 10;
      }
      if (len > MAX_MESSAGE_BYTES || !masked) {
        sendClose(len > MAX_MESSAGE_BYTES ? 1009 : 1002, len > MAX_MESSAGE_BYTES ? 'message too big' : 'frames must be masked');
        socket.end();
        finish(1002, 'protocol error');
        return;
      }
      if (buffer.length < at + 4 + len) return;
      const mask = buffer.subarray(at, at + 4);
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(at + 4 + len);

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        sendClose(code === 1005 ? 1000 : code, '');
        socket.end();
        finish(code, reason);
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        fragmentOpcode = opcode;
      } else if (opcode === 0x0) fragments.push(payload);
      else continue;
      if (!fin) continue;
      const whole = Buffer.concat(fragments);
      fragments = [];
      const binary = fragmentOpcode === 0x2;
      for (const fn of messageFns) fn(binary ? whole : whole.toString('utf8'), binary);
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on('close', () => finish(1006, 'connection lost'));
  socket.on('error', () => finish(1006, 'connection lost'));
  if (head?.length) {
    buffer = Buffer.concat([buffer, head]);
    queueMicrotask(parse);
  }

  return {
    send(text) {
      if (isOpen && !closeSent && !socket.destroyed) socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    },
    close(code = 1000, reason = '') {
      sendClose(code, reason);
      setTimeout(() => socket.destroy(), 200).unref();
      finish(code, reason);
    },
    onMessage: (fn) => void messageFns.push(fn),
    onClose: (fn) => void closeFns.push(fn),
    open: () => isOpen,
  };
}
