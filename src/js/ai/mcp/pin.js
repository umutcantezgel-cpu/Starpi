// @ts-check
// Pinning of MCP tool definitions, against a server that changes a tool after the user approved it.
// A tool's pin is the SHA-256 of the canonical JSON of everything the model and the user rely on:
// its name, title, description, input schema and declared hints. The user approves a tool together
// with its pin. When a later tools/list shows another pin for it, the tool is held back until the
// user approves the new definition; a tool that was never approved is never offered to a model.
import { canonicalJson, sha256Hex } from '../../core/hash.js';

/**
 * approved: listed with the pin the user approved; changed: listed with another pin; new: listed,
 * never approved; removed: approved, no longer listed; invalid: an entry without a name or an object
 * schema, or a name listed twice.
 * @typedef {'approved' | 'changed' | 'new' | 'removed' | 'invalid'} PinStatus
 */

/** @typedef {{ hash: string, approvedAt: string }} PinnedTool */
/** @typedef {Record<string, PinnedTool>} ServerPins  the approved tools of one server, by name */

/**
 * A tool as tools/list describes it (the fields the pin covers).
 * @typedef {object} ListedTool
 * @property {string} name
 * @property {string} [title]
 * @property {string} [description]
 * @property {Record<string, unknown>} inputSchema
 * @property {Record<string, unknown>} [annotations]
 */

/** @typedef {{ name: string, hash: string | null, status: PinStatus, tool: ListedTool | null }} PinCheck */

export const PIN_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Longest tool name read from a server; a longer one is invalid. */
const NAME_MAX = 128;
/** The hints that are part of a pin (other annotation fields are not). */
const HINTS = Object.freeze(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The declared hints of a tool (booleans only), or undefined when it declares none.
 * @param {unknown} annotations
 */
function hintsOf(annotations) {
  if (!isRecord(annotations)) return undefined;
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const h of HINTS) if (typeof annotations[h] === 'boolean') out[h] = annotations[h];
  return Object.keys(out).length ? out : undefined;
}

/**
 * The pin of a tool definition: sha256 of the canonical JSON of name, title, description, input
 * schema and hints (absent fields are left out).
 * @param {ListedTool} tool
 * @returns {Promise<string>} sha256:<64 hex>
 */
export async function toolPin(tool) {
  const text = canonicalJson({
    name: tool.name,
    title: typeof tool.title === 'string' ? tool.title : undefined,
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema,
    hints: hintsOf(tool.annotations),
  });
  return `sha256:${await sha256Hex(text)}`;
}

/**
 * Compares what a server lists with the tools the user approved.
 * @param {ServerPins} pins
 * @param {unknown[]} listed  the `tools` of tools/list
 * @returns {Promise<PinCheck[]>}
 */
export async function comparePins(pins, listed) {
  /** @type {Map<string, number>} */
  const count = new Map();
  for (const t of listed) if (isRecord(t) && typeof t.name === 'string') count.set(t.name, (count.get(t.name) ?? 0) + 1);
  /** @type {PinCheck[]} */
  const out = [];
  let invalid = 0;
  for (const t of listed) {
    if (!isRecord(t) || typeof t.name !== 'string' || !t.name || t.name.length > NAME_MAX || !isRecord(t.inputSchema)) {
      invalid += 1;
      continue;
    }
    if (/** @type {number} */ (count.get(t.name)) > 1) {
      if (!out.some((c) => c.name === t.name)) out.push({ name: t.name, hash: null, status: 'invalid', tool: null });
      continue;
    }
    const tool = /** @type {ListedTool} */ (t);
    const hash = await toolPin(tool);
    const pin = Object.hasOwn(pins, t.name) ? pins[t.name] : null;
    /** @type {PinStatus} */
    const status = !pin ? 'new' : pin.hash === hash ? 'approved' : 'changed';
    out.push({ name: t.name, hash, status, tool });
  }
  for (const name of Object.keys(pins)) if (!count.has(name)) out.push({ name, hash: null, status: 'removed', tool: null });
  if (invalid > 0) out.push({ name: '', hash: null, status: 'invalid', tool: null });
  return out;
}

/**
 * The checks of an earlier tools/list against the pins as they are now: an approval or withdrawal
 * made after the list was read shows at once, without asking the server again.
 * @param {ServerPins} pins
 * @param {readonly PinCheck[]} checks  a comparePins result
 * @returns {PinCheck[]}
 */
export function restatePins(pins, checks) {
  const listed = checks.filter((c) => c.status !== 'removed');
  /** @type {PinCheck[]} */
  const out = listed.map((c) => {
    if (c.status === 'invalid' || !c.hash) return c;
    const pin = Object.hasOwn(pins, c.name) ? pins[c.name] : null;
    return { ...c, status: !pin ? 'new' : pin.hash === c.hash ? 'approved' : 'changed' };
  });
  const names = new Set(listed.map((c) => c.name));
  for (const name of Object.keys(pins)) if (!names.has(name)) out.push({ name, hash: null, status: 'removed', tool: null });
  return out;
}

/**
 * The pins with one tool approved at `hash`.
 * @param {ServerPins} pins
 * @param {string} name
 * @param {string} hash
 * @param {() => Date} [now]
 * @returns {ServerPins}
 */
export function approvePin(pins, name, hash, now = () => new Date()) {
  if (!PIN_PATTERN.test(hash)) throw new TypeError('approvePin needs a sha256 pin');
  return { ...pins, [name]: { hash, approvedAt: now().toISOString() } };
}

/**
 * The pins without one tool.
 * @param {ServerPins} pins
 * @param {string} name
 * @returns {ServerPins}
 */
export function revokePin(pins, name) {
  const next = { ...pins };
  delete next[name];
  return next;
}

/**
 * Valid pins only (from storage).
 * @param {unknown} raw
 * @returns {ServerPins}
 */
export function readPins(raw) {
  /** @type {ServerPins} */
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [name, pin] of Object.entries(raw)) {
    if (name && name.length <= NAME_MAX && isRecord(pin) && typeof pin.hash === 'string' && PIN_PATTERN.test(pin.hash)) {
      out[name] = { hash: pin.hash, approvedAt: typeof pin.approvedAt === 'string' ? pin.approvedAt.slice(0, 40) : '' };
    }
  }
  return out;
}
