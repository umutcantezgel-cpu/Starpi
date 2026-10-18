// @ts-check
// Approvals of tool calls. Whether a call may run follows the tool's side-effect class:
//   read   (built-in)  runs without asking
//   low                asks; "Always allow" may be remembered for that tool
//   high               asks every time ("Always allow" is never offered)
//   forbidden          refused without asking
// A tool marked askEachTime (one whose every call costs money) asks every time, whatever its class.
// An MCP tool asks too, whatever its class, until the user chooses "Always allow" for it (offered
// for read and low only). That choice is remembered together with the pinned hash of the tool's
// definition (mcp/pin.js), so a server that changes a tool's description or schema loses the
// approval and asks again. A destructive tool is "high" and is therefore never run without the
// user's click.
//
// The question goes to the `ask` function the host supplies: the chat shows an approval card in the
// answer (renderApprovalCard), tests answer directly. Remembered approvals live in localStorage
// (names and hashes only, never arguments); remembered() lists them and forgetKey()/forget() undo
// them (the settings show the list).
import { escapeHtml } from '../../ui/kit.js';
import { setText, t } from '../../i18n/index.js';
import { refreshIcons } from '../../icons.js';
import { readLocalJson, writeLocalJson } from '../../storage.js';

/** @typedef {import('./registry.js').ToolDef} ToolDef */
/** @typedef {import('./registry.js').SideEffect} SideEffect */

/** @typedef {'once' | 'always' | 'deny'} ApprovalAnswer */

/**
 * What an approval card shows.
 * @typedef {object} ApprovalRequest
 * @property {string} tool          the tool's name as the model called it
 * @property {string} title         the name to show (the MCP tool's own name, or the built-in's label)
 * @property {SideEffect} effect
 * @property {Record<string, unknown>} args
 * @property {{ id: string, name: string } | null} server
 * @property {boolean} allowAlways  whether "Always allow" is offered
 */

/** @typedef {{ ok: true, remembered: boolean } | { ok: false, reason: 'forbidden' | 'denied' | 'no_approver' | 'cancelled' }} ApprovalDecision */

/**
 * Where remembered approvals are kept.
 * @typedef {object} ApprovalStore
 * @property {(key: string) => { hash?: string } | null} get
 * @property {(key: string, value: { hash?: string }) => void} set
 * @property {(key: string) => void} remove
 * @property {(prefix: string) => void} removePrefix
 * @property {() => Array<{ key: string, at: string }>} list
 */

export const APPROVALS_KEY = 'starpi_tool_approvals_v1';
const MAX_REMEMBERED = 500;
const ARGS_PREVIEW_CHARS = 1200;

/**
 * The approval store in localStorage.
 * @returns {ApprovalStore}
 */
export function localApprovalStore() {
  /** @returns {Record<string, { hash?: string, at?: string }>} */
  const all = () => {
    const raw = readLocalJson(APPROVALS_KEY, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  };
  return {
    get(key) {
      const entry = all()[key];
      return entry && typeof entry === 'object' ? { ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}) } : null;
    },
    set(key, value) {
      const next = all();
      next[key] = { ...(value.hash ? { hash: value.hash } : {}), at: new Date().toISOString() };
      const keys = Object.keys(next);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete next[old];
      writeLocalJson(APPROVALS_KEY, next);
    },
    remove(key) {
      const next = all();
      if (!Object.hasOwn(next, key)) return;
      delete next[key];
      writeLocalJson(APPROVALS_KEY, next);
    },
    removePrefix(prefix) {
      const next = all();
      for (const k of Object.keys(next)) if (k.startsWith(prefix)) delete next[k];
      writeLocalJson(APPROVALS_KEY, next);
    },
    list() {
      return Object.entries(all()).map(([key, v]) => ({ key, at: v && typeof v.at === 'string' ? v.at.slice(0, 40) : '' }));
    },
  };
}

/**
 * An approval store in memory (tests, private windows).
 * @returns {ApprovalStore}
 */
export function memoryApprovalStore() {
  /** @type {Map<string, { hash?: string, at: string }>} */
  const map = new Map();
  return {
    get: (key) => {
      const entry = map.get(key);
      return entry ? { ...(entry.hash ? { hash: entry.hash } : {}) } : null;
    },
    set: (key, value) => void map.set(key, { ...value, at: new Date().toISOString() }),
    remove: (key) => void map.delete(key),
    removePrefix: (prefix) => {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
    list: () => [...map.entries()].map(([key, v]) => ({ key, at: v.at })),
  };
}

/**
 * The key a remembered approval of an MCP server's tool is stored under.
 * @param {string} serverId
 * @param {string} tool  the tool's own name on the server
 */
export function mcpApprovalKey(serverId, tool) {
  return `mcp:${serverId}:${tool}`;
}

/**
 * The key a remembered approval is stored under.
 * @param {ToolDef} def
 */
export function approvalKey(def) {
  return def.server ? mcpApprovalKey(def.server.id, def.server.tool) : `tool:${def.name}`;
}

/**
 * Whether "Always allow" may be offered (and remembered) for a tool.
 * @param {ToolDef} def
 */
export function mayAllowAlways(def) {
  return def.effect !== 'high' && def.effect !== 'forbidden' && def.askEachTime !== true;
}

/**
 * What a remembered approval's key names: a built-in tool, or a tool of an MCP server.
 * @param {string} key
 * @returns {{ kind: 'tool', name: string } | { kind: 'mcp', serverId: string, tool: string } | null}
 */
export function parseApprovalKey(key) {
  if (key.startsWith('tool:') && key.length > 5) return { kind: 'tool', name: key.slice(5) };
  const m = /^mcp:([^:]+):(.+)$/.exec(key);
  return m ? { kind: 'mcp', serverId: m[1], tool: m[2] } : null;
}

/**
 * Whether a call of this tool needs the user's answer before it runs (ignoring remembered ones).
 * @param {ToolDef} def
 */
export function needsApproval(def) {
  return def.effect !== 'forbidden' && (def.origin === 'mcp' || Boolean(def.server) || def.effect !== 'read');
}

/**
 * The gate every tool call passes. `onChange` hears when the remembered approvals change.
 * @param {{ ask?: ((req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>) | null, store?: ApprovalStore, onChange?: () => void }} [opts]
 */
export function createApprovalGate(opts = {}) {
  const store = opts.store ?? memoryApprovalStore();
  const changed = () => {
    try {
      opts.onChange?.();
    } catch {
      // a listener's failure must not stop a call
    }
  };
  return {
    /**
     * @param {ToolDef} def
     * @param {Record<string, unknown>} args
     * @param {AbortSignal} signal
     * @param {{ ask?: ((req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>) | null, title?: string }} [call]  replaces the gate's ask for this call; the name to show
     * @returns {Promise<ApprovalDecision>}
     */
    async decide(def, args, signal, call = {}) {
      if (def.effect === 'forbidden') return { ok: false, reason: 'forbidden' };
      if (!needsApproval(def)) return { ok: true, remembered: false };
      const key = approvalKey(def);
      const allowAlways = mayAllowAlways(def);
      const remembered = allowAlways ? store.get(key) : null;
      if (remembered && (!def.server || remembered.hash === def.server.hash)) return { ok: true, remembered: true };
      const ask = call.ask ?? opts.ask;
      if (!ask) return { ok: false, reason: 'no_approver' };
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      const answer = await ask({ tool: def.name, title: call.title ?? def.server?.tool ?? def.name, effect: def.effect, args, server: def.server ? { id: def.server.id, name: def.server.name } : null, allowAlways }, signal);
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      if (answer === 'always' && allowAlways) {
        store.set(key, def.server ? { hash: def.server.hash } : {});
        changed();
      }
      return answer === 'once' || answer === 'always' ? { ok: true, remembered: false } : { ok: false, reason: 'denied' };
    },
    /**
     * Forgets the remembered approvals of one MCP server (removed or changed), or all.
     * @param {string} [serverId]
     */
    forget(serverId) {
      store.removePrefix(serverId ? `mcp:${serverId}:` : '');
      changed();
    },
    /**
     * Forgets one remembered approval (approvalKey / mcpApprovalKey).
     * @param {string} key
     */
    forgetKey(key) {
      store.remove(key);
      changed();
    },
    /** The remembered approvals, newest first. */
    remembered() {
      return store
        .list()
        .filter((e) => parseApprovalKey(e.key) !== null)
        .sort((a, b) => b.at.localeCompare(a.at));
    },
    store,
  };
}

/** @typedef {ReturnType<typeof createApprovalGate>} ApprovalGate */

// ---------------------------------------------------------------------------------------------
// The approval card and the activity lines in an answer
// ---------------------------------------------------------------------------------------------

const EFFECT_TONES = /** @type {const} */ ({ read: 'chip-info', low: 'chip-warn', high: 'chip-danger', forbidden: 'chip-danger' });

/**
 * The box in an answer bubble that holds its tool activity (created on first use, before the text).
 * @param {HTMLElement} messageEl  the answer's message row
 */
export function activityBox(messageEl) {
  let box = /** @type {HTMLElement | null} */ (messageEl.querySelector('.tool-activity'));
  if (box) return box;
  box = messageEl.ownerDocument.createElement('div');
  box.className = 'tool-activity mb-2 flex flex-col gap-1.5';
  const content = messageEl.querySelector('.message-content');
  if (content?.parentElement) content.parentElement.insertBefore(box, content);
  else messageEl.append(box);
  return box;
}

/**
 * The arguments of a call as shown on a card: indented JSON, cut to a readable length.
 * @param {Record<string, unknown>} args
 */
export function argsPreview(args) {
  let text;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = '{}';
  }
  return text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…` : text;
}

/**
 * Shows an approval card in `host` and resolves with the user's answer. A stopped answer (`signal`)
 * resolves 'deny'. The card stays, with its outcome, after the answer.
 * @param {HTMLElement} host
 * @param {ApprovalRequest} req
 * @param {AbortSignal} signal
 * @returns {Promise<ApprovalAnswer>}
 */
export function renderApprovalCard(host, req, signal) {
  const card = host.ownerDocument.createElement('div');
  card.className = 'tool-approval rounded-xl border border-amber-300 bg-amber-50 text-amber-950 p-3 text-xs space-y-2';
  card.setAttribute('role', 'group');
  card.dataset.tool = req.tool;
  card.dataset.effect = req.effect;
  const effectKey = `tools.effect.${req.effect}`;
  const originKey = req.server ? 'tools.approval.from_server' : 'tools.approval.builtin';
  /** @type {Record<string, string>} */
  const originParams = req.server ? { server: req.server.name } : {};
  card.innerHTML = `
    <p class="flex flex-wrap items-center gap-1.5 font-medium"><i data-lucide="shield-alert" class="w-4 h-4"></i><span class="approval-title"></span><span class="chip ${EFFECT_TONES[req.effect]}"><i data-lucide="${req.effect === 'read' ? 'info' : 'triangle-alert'}"></i><span data-i18n="${escapeHtml(effectKey)}">${escapeHtml(t(effectKey))}</span></span></p>
    <p class="approval-origin text-[11px] text-amber-900"></p>
    <details class="approval-args"><summary class="cursor-pointer select-none" data-i18n="tools.approval.args">${escapeHtml(t('tools.approval.args'))}</summary><pre class="mt-1 max-h-48 overflow-auto rounded-lg bg-white/70 border border-amber-200 p-2 font-mono text-[11px] whitespace-pre-wrap break-words"></pre></details>
    <div class="approval-buttons flex flex-wrap items-center gap-1.5">
      <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" data-answer="once" data-i18n="tools.approval.once">${escapeHtml(t('tools.approval.once'))}</button>
      ${req.allowAlways ? `<button type="button" class="btn btn-ghost px-2.5 py-1 text-xs border border-amber-300" data-answer="always" data-i18n="tools.approval.always">${escapeHtml(t('tools.approval.always'))}</button>` : ''}
      <button type="button" class="btn btn-ghost px-2.5 py-1 text-xs border border-amber-300" data-answer="deny" data-i18n="tools.approval.deny">${escapeHtml(t('tools.approval.deny'))}</button>
    </div>
    <p class="approval-outcome hidden text-[11px] font-medium" role="status"></p>`;
  setText(/** @type {HTMLElement} */ (card.querySelector('.approval-title')), 'tools.approval.title', { tool: req.title });
  setText(/** @type {HTMLElement} */ (card.querySelector('.approval-origin')), originKey, originParams);
  /** @type {HTMLElement} */ (card.querySelector('pre')).textContent = argsPreview(req.args);
  card.setAttribute('aria-label', t('tools.approval.title', { tool: req.title }));
  host.append(card);
  refreshIcons(card);
  /** @type {HTMLButtonElement | null} */ (card.querySelector('[data-answer="once"]'))?.focus({ preventScroll: true });

  return new Promise((resolve) => {
    /** @param {ApprovalAnswer} answer */
    const finish = (answer) => {
      signal.removeEventListener('abort', onAbort);
      card.querySelector('.approval-buttons')?.remove();
      const outcome = /** @type {HTMLElement} */ (card.querySelector('.approval-outcome'));
      setText(outcome, answer === 'deny' ? 'tools.approval.denied' : answer === 'always' ? 'tools.approval.allowed_always' : 'tools.approval.allowed');
      outcome.classList.remove('hidden');
      card.dataset.answer = answer;
      resolve(answer);
    };
    const onAbort = () => finish('deny');
    if (signal.aborted) return finish('deny');
    signal.addEventListener('abort', onAbort, { once: true });
    for (const btn of card.querySelectorAll('button[data-answer]')) {
      btn.addEventListener('click', () => finish(/** @type {ApprovalAnswer} */ (/** @type {HTMLElement} */ (btn).dataset.answer)), { once: true });
    }
  });
}

/**
 * One line per tool call in `host`: running, then its outcome.
 * @param {HTMLElement} host
 */
export function createToolActivity(host) {
  return {
    /**
     * @param {string} id
     * @param {string} title
     */
    start(id, title) {
      const line = host.ownerDocument.createElement('p');
      line.className = 'tool-call flex items-center gap-1.5 text-[11px] text-slate-600';
      line.dataset.call = id;
      line.dataset.status = 'running';
      line.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"></i><span></span>';
      setText(/** @type {HTMLElement} */ (line.querySelector('span')), 'tools.activity.running', { tool: title });
      host.append(line);
      refreshIcons(line);
    },
    /**
     * @param {string} id
     * @param {string} title
     * @param {'done' | 'failed' | 'denied' | 'forbidden'} status
     */
    finish(id, title, status) {
      const line = /** @type {HTMLElement | undefined} */ ([...host.querySelectorAll('.tool-call')].find((el) => /** @type {HTMLElement} */ (el).dataset.call === id));
      if (!line) return;
      line.dataset.status = status;
      const iconName = status === 'done' ? 'check' : status === 'failed' ? 'triangle-alert' : 'x';
      line.innerHTML = `<i data-lucide="${iconName}" class="w-3.5 h-3.5"></i><span></span>`;
      setText(/** @type {HTMLElement} */ (line.querySelector('span')), `tools.activity.${status}`, { tool: title });
      refreshIcons(line);
    },
    /** @param {number} rounds */
    limit(rounds) {
      const note = host.ownerDocument.createElement('p');
      note.className = 'tool-limit text-[11px] text-amber-900';
      setText(note, 'tools.activity.round_limit', { n: String(rounds) });
      host.append(note);
    },
  };
}
