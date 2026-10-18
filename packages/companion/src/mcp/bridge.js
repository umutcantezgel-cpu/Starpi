// @ts-check
// The stdio bridge of the MCP server (bin/mcp-stdio.mjs runs it): a desktop MCP client talks to it
// over standard input and output, one JSON-RPC message per line, and it passes each message on to
// POST http://127.0.0.1:<port>/v1/mcp with the client's token. It connects to 127.0.0.1 only,
// sends no cookie and no Origin, starts no process and keeps nothing. Messages are passed on in
// order; a request the companion could not answer gets a JSON-RPC error for its id (codes -32001 to
// -32004), so the client never waits forever, and the token never appears in any output.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createInterface } from 'node:readline';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47821;
const MAX_LINE = 64 * 1024;
const MAX_ANSWER = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const USAGE = 'usage: starpi-companion-mcp --token-file <file, chmod 600> [--port <port of the companion>]';

const FAILURES = Object.freeze({
  unreachable: { code: -32001, message: 'Starpi Core is not reachable on this machine' },
  timeout: { code: -32002, message: 'Starpi Core did not answer in time' },
  refused: { code: -32003, message: 'Starpi Core refused the request' },
  oversized: { code: -32004, message: 'the message or its answer is too large' },
});

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function parseArgs(argv, env) {
  /** @type {string | null} */
  let tokenFile = null;
  /** @type {string | null} */
  let port = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--token-file' && tokenFile === null && i + 1 < argv.length) tokenFile = argv[++i];
    else if (arg === '--port' && port === null && i + 1 < argv.length) port = argv[++i];
    else throw new Error(arg === '--help' ? USAGE : `unknown or repeated argument (the token is read from --token-file only)\n${USAGE}`);
  }
  if (!tokenFile) throw new Error(`--token-file is required\n${USAGE}`);
  const rawPort = port ?? env.STARPI_COMPANION_PORT ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('--port is a port number; the bridge always connects to 127.0.0.1');
  return { tokenFile, port: Number(rawPort) };
}

/**
 * Reads the token: a regular file (not a link) of this user, unreadable for others.
 * @param {string} file
 */
export function readToken(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error('the token file cannot be opened (it must exist and must not be a link)');
  }
  const buffer = Buffer.alloc(1024);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('the token file must be a regular file');
    if ((st.mode & 0o077) !== 0) throw new Error('others may read the token file; run chmod 600 on it');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the token file must belong to the user running the bridge');
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, n).toString('utf8').trim();
    if (!TOKEN.test(token)) throw new Error('the token file holds no token');
    return token;
  } finally {
    buffer.fill(0);
    closeSync(fd);
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Runs the bridge on the given streams.
 * @param {{ port: number, token: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, log: (line: string) => void }} io
 * @returns {Promise<void>} resolves when the input ended and every answer was written
 */
export function runBridge({ port, token, input, output, log }) {
  const agent = new Agent({ keepAlive: true, maxSockets: 2 });
  /** @type {string | null} */
  let protocolVersion = null;
  /** @param {unknown} message */
  const write = (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  /**
   * @param {Buffer} body
   * @returns {Promise<{ status: number, text: string } | { failure: keyof typeof FAILURES }>}
   */
  const post = (body) =>
    new Promise((resolve) => {
      /** @type {Record<string, string | number>} */
      const headers = {
        host: `${HOST}:${port}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': body.length,
        authorization: `Bearer ${token}`,
      };
      if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
      const req = request({ host: HOST, port, family: 4, method: 'POST', path: '/v1/mcp', headers, agent, timeout: TIMEOUT_MS }, (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_ANSWER) {
            resolve({ failure: 'oversized' });
            res.destroy();
            return;
          }
          parts.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
        res.on('error', () => resolve({ failure: 'unreachable' }));
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ failure: 'timeout' });
      });
      req.on('error', () => resolve({ failure: 'unreachable' }));
      req.end(body);
    });

  /** @param {string} line */
  async function handle(line) {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the line is not JSON' } });
      return;
    }
    const id = isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    const isRequest = id !== null && isObject(message) && typeof message.method === 'string';
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > MAX_LINE) {
      if (isRequest) write({ jsonrpc: '2.0', id, error: FAILURES.oversized });
      return;
    }
    const answer = await post(body);
    if ('failure' in answer) {
      log(FAILURES[answer.failure].message);
      if (isRequest) write({ jsonrpc: '2.0', id, error: FAILURES[answer.failure] });
      return;
    }
    if (answer.status === 202 || answer.text === '') return;
    let parsed;
    try {
      parsed = JSON.parse(answer.text);
    } catch {
      parsed = null;
    }
    if (isObject(parsed) && parsed.jsonrpc === '2.0') {
      if (isRequest && message.method === 'initialize' && isObject(parsed.result) && typeof parsed.result.protocolVersion === 'string') protocolVersion = parsed.result.protocolVersion;
      write(parsed);
      return;
    }
    // An HTTP refusal (wrong token, a revoked client): an error for the request, a hint on stderr.
    const code = isObject(parsed) && isObject(parsed.error) && typeof parsed.error.code === 'string' ? parsed.error.code : `http_${answer.status}`;
    log(`the companion answered ${answer.status} (${code})`);
    if (isRequest) write({ jsonrpc: '2.0', id, error: { ...FAILURES.refused, data: { status: answer.status, code } } });
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let chain = Promise.resolve();
    lines.on('line', (line) => {
      chain = chain.then(() => handle(line)).catch(() => log('a message could not be passed on'));
    });
    lines.on('close', () => {
      chain.then(() => {
        agent.destroy();
        resolve(undefined);
      });
    });
  });
}

/**
 * The command line: reads the arguments and the token, then bridges stdin and stdout.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: (text: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function bridgeMain(argv, io = {}) {
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let config;
  let token;
  try {
    config = parseArgs(argv, io.env ?? process.env);
    token = readToken(config.tokenFile);
  } catch (err) {
    stderr(`starpi-companion-mcp: ${/** @type {Error} */ (err).message}\n`);
    return 2;
  }
  await runBridge({ port: config.port, token, input: io.stdin ?? process.stdin, output: io.stdout ?? process.stdout, log: (line) => stderr(`starpi-companion-mcp: ${line}\n`) });
  return 0;
}
