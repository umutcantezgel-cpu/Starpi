#!/usr/bin/env node
// Starts every fake provider on consecutive ports of 127.0.0.1 and prints where each listens
// (one NAME_URL=... line per fake, then one JSON line). The base port answers GET / with the same
// list as JSON, which is what the Playwright webServer entry waits for.
//
//   base + 0  this list        base + 4  elevenlabs
//   base + 1  openai           base + 5  voice
//   base + 2  anthropic        base + 6  mcp
//   base + 3  gemini           base + 7  search
//
// The printed URLs are what a client is configured with: API roots (requests add /v1/..., or
// /v1beta/... for Gemini) and the MCP endpoint. The OpenAI-compatible fake serves every flavor
// under <root>/flavor/<name> (xai, groq, mistral, deepseek, openrouter, nvidia, ollama); the root
// itself is the default flavor (FAKE_FLAVOR, else openai).
//
// Usage: node scripts/fakes/index.mjs [--base-port 4610] [--marker starpi-purpose] [--fixtures dir] [--verbose]
// (environment: STARPI_FAKES_PORT for the base port, FAKE_FLAVOR, FAKE_GAP_MS, FAKE_LATENCY_MS, FAKE_CORS)
// The planned `npm run fakes` script runs exactly this command; until package.json has it, call
// node directly. Each fake also runs on its own: node scripts/fakes/<name>.mjs --port <n>.
import { createServer } from 'node:http';
import { createAnthropicFake } from './anthropic.mjs';
import { createElevenLabsFake } from './elevenlabs.mjs';
import { createGeminiFake } from './gemini.mjs';
import { createMcpFake } from './mcp.mjs';
import { createOpenAiFake } from './openai.mjs';
import { createSearchFake } from './search.mjs';
import { commonOptions, HOST, isMain, parseArgs } from './shared.mjs';
import { createVoiceFake } from './voice.mjs';

export const DEFAULT_BASE_PORT = 4610;

/**
 * What a client is configured with, per fake: the API root, or the endpoint for MCP.
 * @param {Record<string, string>} origins
 */
export function clientUrls(origins) {
  return { ...origins, mcp: `${origins.mcp}/mcp` };
}

/**
 * Starts all fakes. With basePort 0 every fake gets a free port (for tests) and no list server
 * is started on a fixed port.
 * @param {{ basePort?: number, flavor?: string, marker?: string, fixturesDir?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 * @returns {Promise<{ origins: Record<string, string>, urls: ReturnType<typeof clientUrls>, listUrl: string, close: () => Promise<void> }>}
 */
export async function startAllFakes(options = {}) {
  const base = options.basePort ?? DEFAULT_BASE_PORT;
  const shared = { marker: options.marker, fixturesDir: options.fixturesDir, gapMs: options.gapMs, latencyMs: options.latencyMs, cors: options.cors, log: options.log };
  const fakes = /** @type {const} */ ([
    ['openai', createOpenAiFake({ ...shared, flavor: options.flavor })],
    ['anthropic', createAnthropicFake(shared)],
    ['gemini', createGeminiFake(shared)],
    ['elevenlabs', createElevenLabsFake(shared)],
    ['voice', createVoiceFake(shared)],
    ['mcp', createMcpFake(shared)],
    ['search', createSearchFake(shared)],
  ]);
  /** @type {Record<string, string>} */
  const origins = {};
  const started = [];
  try {
    for (const [i, [name, fake]] of fakes.entries()) {
      const { url } = await fake.listen(base ? base + 1 + i : 0);
      origins[name] = url;
      started.push(fake);
    }
  } catch (err) {
    await Promise.all(started.map((f) => f.close()));
    throw err;
  }
  const urls = clientUrls(origins);
  const list = createServer((req, res) => {
    res.writeHead(req.url === '/' || req.url === '/health' ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ origins, urls }));
  });
  await new Promise((resolve, reject) => {
    list.once('error', reject);
    list.listen(base, HOST, () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (list.address());
  return {
    origins,
    urls,
    listUrl: `http://${HOST}:${address.port}/`,
    async close() {
      list.closeAllConnections();
      await new Promise((resolve) => list.close(() => resolve(undefined)));
      await Promise.all(fakes.map(([, f]) => f.close()));
    },
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const common = commonOptions(args);
  const basePort = Number(args['base-port'] ?? process.env.STARPI_FAKES_PORT ?? DEFAULT_BASE_PORT);
  const running = await startAllFakes({ ...common, basePort, flavor: args.flavor ?? process.env.FAKE_FLAVOR, log: args.verbose ? (l) => console.log(l) : undefined });
  for (const [name, url] of Object.entries(running.urls)) console.log(`FAKE_${name.toUpperCase()}_URL=${url}`);
  console.log(JSON.stringify({ list: running.listUrl, ...running.urls }));
  const stop = () => running.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
