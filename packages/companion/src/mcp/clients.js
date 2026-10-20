// @ts-check
// MCP clients: desktop applications the owner allowed to read through the MCP server. Each has its
// own bearer token, shown once when it is made and kept only as a SHA-256 hash in the vault
// namespace `mcp`, a label, the tools it may use and a few counters. A paired browser session can
// never act as an MCP client, and an MCP token opens nothing but the MCP endpoint.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord } from '../contracts/check.js';
import { isoAt } from '../lib/clock.js';
import { idPattern, newId } from '../setup/kit.js';

export const CLIENTS_NAMESPACE = 'mcp';
export const MAX_CLIENTS = 32;
const CLIENT_ID = idPattern('mcpc');

/**
 * @typedef {object} McpClient
 * @property {string} id
 * @property {string} label
 * @property {string[]} tools
 * @property {string} tokenHash
 * @property {string} created
 * @property {string | null} lastUsed
 * @property {number} calls
 */

/** @param {string} token */
const hashOf = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * @param {{ namespace: any, clock: import('../lib/clock.js').Clock }} deps
 */
export function createClientStore({ namespace, clock }) {
  /** @returns {McpClient[]} */
  function all() {
    /** @type {McpClient[]} */
    const out = [];
    for (const { id } of namespace.list()) {
      if (!CLIENT_ID.test(id)) continue;
      const value = namespace.getJson(id);
      if (isRecord(value) && typeof value.tokenHash === 'string') out.push(/** @type {McpClient} */ (/** @type {unknown} */ (value)));
    }
    return out.sort((a, b) => a.created.localeCompare(b.created));
  }

  /** What a list shows: never the hash. @param {McpClient} c */
  const view = (c) => ({ id: c.id, label: c.label, tools: c.tools, created: c.created, lastUsed: c.lastUsed, calls: c.calls });

  return {
    list: () => all().map(view),
    count: () => all().length,
    /**
     * A new client and its token (the only time the token exists outside the client).
     * @param {string} label
     * @param {string[]} tools
     */
    create(label, tools) {
      const token = randomBytes(32).toString('base64url');
      /** @type {McpClient} */
      const client = { id: newId('mcpc'), label, tools, tokenHash: hashOf(token), created: isoAt(clock.now()), lastUsed: null, calls: 0 };
      namespace.putJson(client.id, client);
      return { client: view(client), token };
    },
    /**
     * The client a bearer token belongs to, or null.
     * @param {string} token
     * @returns {McpClient | null}
     */
    authenticate(token) {
      const wanted = Buffer.from(hashOf(token), 'hex');
      for (const c of all()) {
        const have = Buffer.from(c.tokenHash, 'hex');
        if (have.length === wanted.length && timingSafeEqual(have, wanted)) return c;
      }
      return null;
    },
    /** Counts a call. @param {McpClient} c */
    used(c) {
      namespace.putJson(c.id, { ...c, lastUsed: isoAt(clock.now()), calls: c.calls + 1 });
    },
    /** @param {string} id */
    revoke: (id) => CLIENT_ID.test(id) && namespace.delete(id),
  };
}

/** @typedef {ReturnType<typeof createClientStore>} ClientStore */
