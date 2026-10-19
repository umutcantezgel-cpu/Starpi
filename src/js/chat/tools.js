// @ts-check
/**
 * @file The chat's side of tools: what the free chat offers a model, and what happens when the
 * model calls. Installed once by the tools feature (features/tools.js), after the first paint.
 *
 * - The registry holds the built-in tools, the image tool and the approved tools of MCP servers
 *   (ai/mcp/client.js bridge). Settings and the composer's tools menu switch the built-in groups.
 * - A request hook offers them to models that can call tools (never to models on this device and
 *   never on the site's pools), with the rule that tool output is untrusted data. The loop runs
 *   only what a request offered, so a switch that is off holds when the tool would run, too.
 * - The tool runner runs the loop (ai/tools/loop.js) for an answer that stopped for tool calls;
 *   approval cards and one line per call appear in the answer's bubble.
 * - Verified web answer: with Web on, a model without a search of its own and a search service set
 *   up, the question is searched first and the web pack goes into the turn's notes; once the answer
 *   is in, the runner checks it against the results (ai/search.js), keeps the citations of the
 *   statements the check supports and hands back the outcome as the answer's web check (the thread
 *   labels and stores it as its own web check: "n of m statements found"). The pack stays for
 *   answers written again from the same turn (regenerate, compare columns) until the next question.
 * - memory_lookup answers from the memory feature (hooks.js setMemoryLookup): offered only while
 *   memory is on, with the notes the conversation of the turn may use.
 * - A question that stays on this device (TurnContext.localOnly) gets no web pack and is offered
 *   only the tools whose results stay with the model answering it (ON_DEVICE_TOOLS).
 * - Provider-side MCP servers (behind their flag) reach Anthropic and OpenAI calls through an
 *   adapter chooser.
 */
import { createAnthropicWireAdapter } from '../ai/adapters/anthropic.js';
import { getAdapter } from '../ai/index.js';
import { ACCESS_SLOT, getKey, keyStore } from '../ai/keys.js';
import { createMcpBridge, createServerStore, PROVIDER_MCP, withProviderMcp } from '../ai/mcp/client.js';
import { checkWebAnswer, readSearchSettings, searchReady, webPack, webSearch } from '../ai/search.js';
import { createApprovalGate, activityBox, createToolActivity, localApprovalStore, renderApprovalCard } from '../ai/tools/approval.js';
import { builtinTools, DEFAULT_TOOL_SWITCHES, readToolSwitches, TOOL_SETTINGS_KEY } from '../ai/tools/builtin.js';
import { runToolLoop } from '../ai/tools/loop.js';
import { createToolRegistry, TOOL_RESULT_RULE } from '../ai/tools/registry.js';
import { getLocale, t } from '../i18n/index.js';
import { routeOf } from '../providers.js';
import { searchWorkspace } from '../rag/workspace.js';
import { getAssistant, getWebSearch } from '../state.js';
import { readLocalJson, writeLocalJson } from '../storage.js';
import { registerComposerTool, registerRequestHook, registerTurnNotes, setAdapterChooser, setToolRunner, single } from './hooks.js';
import { imageProvider, imageTool } from './image-view.js';
import { capsOf, chatCandidates } from './runner.js';

/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('../ai/tools/registry.js').ToolDef} ToolDef */
/** @typedef {import('../ai/tools/builtin.js').ToolSwitches} ToolSwitches */
/** @typedef {import('../ai/search.js').WebPack} WebPack */
/** @typedef {import('./hooks.js').TurnContext} TurnContext */

/** Web packs kept for answers still being written, at most. */
const MAX_PACKS = 20;
/**
 * The built-in tools that keep a question on this device (their results go only to the model that
 * answers it): the only tools a question that stays here is offered. The web search, image
 * generation and MCP servers would carry what the model writes elsewhere.
 */
const ON_DEVICE_TOOLS = new Set(['datetime', 'calculator', 'workspace_search', 'memory_lookup']);
const PACK_SEARCH_MS = 15_000;

/** The composer's tools menu: the groups it switches. */
const MENU = /** @type {const} */ ([
  { id: 'tools-basics', keys: ['datetime', 'calculator'], on: 'tools.menu.basics_on', off: 'tools.menu.basics_off', icon: 'braces' },
  { id: 'tools-files', keys: ['workspace_search'], on: 'tools.menu.files_on', off: 'tools.menu.files_off', icon: 'folder-open' },
  { id: 'tools-web', keys: ['web_search'], on: 'tools.menu.web_on', off: 'tools.menu.web_off', icon: 'globe' },
  { id: 'tools-images', keys: ['generate_image'], on: 'tools.menu.images_on', off: 'tools.menu.images_off', icon: 'sparkles' },
]);

/** @type {ReturnType<typeof createRuntime> | null} */
let runtime = null;

export { setMemoryLookup } from './hooks.js';

/**
 * The memory_lookup tool answering from the notes one conversation may use (null: outside a turn,
 * the global notes).
 * @param {string | null} conversationId
 */
function memoryTool(conversationId) {
  return builtinTools({ memoryLookup: (q, k) => (single.memory ? single.memory.lookup(q, k, conversationId) : Promise.resolve([])) }).find((d) => d.name === 'memory_lookup') ?? null;
}

/**
 * Switches on the built-in tools an assistant names (chat/assistants.js ASSISTANT_TOOLS), as starting
 * a chat with it does; every other tool keeps its setting.
 * @param {readonly string[]} names
 */
export function switchOnTools(names) {
  const keys = Object.keys(DEFAULT_TOOL_SWITCHES).filter((k) => names.includes(k));
  if (!keys.length) return;
  /** @type {Partial<ToolSwitches>} */
  const patch = Object.fromEntries(keys.map((k) => [k, true]));
  if (runtime) runtime.setSwitches(patch);
  else writeLocalJson(TOOL_SETTINGS_KEY, readToolSwitches({ .../** @type {object} */ (readLocalJson(TOOL_SETTINGS_KEY, null) ?? {}), ...patch }));
}

/**
 * Searches with the configured service (throws an AiError when none is set up or it fails).
 * @param {string} query
 * @param {number} count
 * @param {AbortSignal} signal
 */
export function searchWithSettings(query, count, signal) {
  const settings = readSearchSettings();
  const provider = settings.provider === 'off' ? 'brave' : settings.provider;
  return webSearch(query, { provider, key: provider === 'searxng' ? undefined : getKey(provider), baseUrl: settings.searxngUrl, count, signal, access: () => getKey(ACCESS_SLOT) });
}

/** @param {TurnContext} ctx */
const packKey = (ctx) => `${ctx.conversationId}\n${ctx.question}`;

/**
 * The verified web answer: an answer written from a web pack, checked against the pack's results
 * (ai/search.js checkWebAnswer). The [W#] markers leave the text, the statements the check supports
 * cite their pages, and the outcome comes along as the answer's web check (rag/web-check.js shape:
 * `checked`, the pages its markers named, n of m marked statements found), so the thread labels and
 * stores it as its own web check.
 *
 * Null when the answer marks no statement with a result: it stays as it is, and its own citations
 * (a model that searched the web itself) decide its check, as for any other answer. An answer that
 * cites pages of its own besides the markers carries no web check either: the thread checks all its
 * citations together (the pack's supported statements among them), so no flagged statement of its
 * own search goes unseen behind the pack's count.
 * @param {import('../ai/index.js').CompletionResult} base
 * @param {WebPack} pack
 * @returns {import('./hooks.js').ToolRunResult | null}
 */
export function verifiedWebAnswer(base, pack) {
  const check = checkWebAnswer(base.text, pack.results);
  if (!check.statements) return null;
  const answer = { ...base, text: check.text, citations: [...base.citations, ...check.citations] };
  if (base.citations.some((c) => /^https?:\/\//i.test(c.url))) return answer;
  const cited = new Set([...base.text.matchAll(/\[W(\d{1,2})\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= pack.results.length));
  /** @type {import('../rag/web-check.js').WebCheck} */
  const webCheck = { kind: 'checked', pages: cited.size, supported: check.supported, flagged: check.statements - check.supported, total: check.statements };
  return { ...answer, webCheck };
}

/**
 * @param {{ openSettings?: () => void }} [opts]
 */
function createRuntime(opts = {}) {
  const registry = createToolRegistry();
  // The settings list the remembered approvals: an "Always allow" on a card refreshes them.
  const gate = createApprovalGate({ store: localApprovalStore(), onChange: () => changed() });
  const servers = createServerStore({ keys: keyStore });
  const bridge = createMcpBridge({ store: servers, registry });
  let switches = readToolSwitches(readLocalJson(TOOL_SETTINGS_KEY, null));
  /** @type {Map<string, WebPack>} */
  const packs = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // a listener's failure must not stop the others
      }
    }
  };

  const tz = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  };
  for (const def of builtinTools({
    timeZone: tz,
    searchWorkspace: (q, k) => searchWorkspace(q, k),
    memoryLookup: (q, k) => (single.memory ? single.memory.lookup(q, k, null) : Promise.resolve([])),
    webSearch: (q, count, signal) => searchWithSettings(q, count, signal),
  })) {
    registry.register(def);
  }
  registry.register(imageTool({ provider: () => imageProvider() }));

  /**
   * Whether a tool is offered for a call (`webTurn`: the question has a web pack already).
   * @param {ToolDef} def
   * @param {boolean} webTurn
   */
  const offered = (def, webTurn) => {
    // An MCP tool only while its approval stands (a withdrawal counts before the next sync).
    if (def.origin === 'mcp') return bridge.approved(def);
    if (def.name === 'web_search') return switches.web_search && !webTurn && searchReady(readSearchSettings(), getKey);
    if (def.name === 'generate_image') return switches.generate_image && imageProvider() !== null;
    // Memory is offered once the memory feature answers it, and only while memory is on.
    if (def.name === 'memory_lookup') return switches.memory_lookup && Boolean(single.memory?.enabled());
    return Boolean(/** @type {Record<string, boolean>} */ (switches)[def.name]);
  };

  /**
   * Whether a model may be offered tools: it can call them and runs neither on this device nor on
   * the site's pools.
   * @param {ProviderId} provider
   * @param {string} model
   */
  const toolsFit = (provider, model) => {
    if (provider === 'webgpu' || provider === 'wasm') return false;
    const route = routeOf(provider);
    return route !== 'pool' && route !== 'device' && capsOf(provider, model).tools;
  };

  // The tools a request offers.
  registerRequestHook((req, ctx) => {
    if (!toolsFit(req.provider, req.model)) return req;
    // Gemini takes its own Google Search and declared functions in one request only in the Live
    // API: a web turn there keeps the search and offers no functions.
    if (req.provider === 'gemini' && req.search?.enabled) return req;
    const webTurn = packs.has(packKey(ctx));
    // A question that stays on this device is offered only the tools that keep it here.
    const specs = registry.specs((d) => offered(d, webTurn) && (!ctx.localOnly || (d.origin !== 'mcp' && ON_DEVICE_TOOLS.has(d.name)))).filter((s) => !(req.tools ?? []).some((own) => own.name === s.name));
    if (!specs.length) return req;
    const rule = TOOL_RESULT_RULE[getLocale() === 'de' ? 'de' : 'en'];
    return { ...req, tools: [...(req.tools ?? []), ...specs].slice(0, 128), system: [req.system, rule].filter(Boolean).join('\n\n') };
  });

  // The web pack of a question, for a model that cannot search itself. A new question replaces the
  // pack an earlier one with the same words left.
  registerTurnNotes(async (ctx) => {
    packs.delete(packKey(ctx));
    if (!ctx.question.trim() || !getWebSearch()) return [];
    if (!searchReady(readSearchSettings(), getKey)) return [];
    const value = getAssistant();
    // A question asked to stay on this device goes to no search service either (nor one asked with
    // the model here, which keeps it here).
    if (ctx.localOnly || value === 'device') return [];
    const [first] = await chatCandidates(value);
    if (!first) return [];
    const caps = capsOf(first.provider, first.model);
    if (caps.search !== 'none' && first.route !== 'pool') return [];
    /** @type {import('../ai/search.js').SearchResult[]} */
    let results;
    try {
      results = await searchWithSettings(ctx.question, 5, AbortSignal.timeout(PACK_SEARCH_MS));
    } catch (err) {
      console.warn('[starpi] the web search for this question failed', err instanceof Error ? err.message : err);
      return [];
    }
    if (!results.length) return [];
    const pack = webPack(ctx.question, results, { locale: ctx.locale === 'de' ? 'de' : 'en', maxChars: caps.contextTokens < 8192 ? 2500 : 6000 });
    packs.set(packKey(ctx), pack);
    while (packs.size > MAX_PACKS) packs.delete(/** @type {string} */ (packs.keys().next().value));
    return [pack.text];
  });

  /**
   * The adapter of a call with provider-side MCP servers (only with the flag on).
   * @param {{ provider: string, model: string, route: string }} target
   * @returns {import('../ai/stream.js').Adapter | undefined}
   */
  const chooseAdapter = (target) => {
    if (!servers.providerSide() || !Object.hasOwn(PROVIDER_MCP, target.provider) || target.route === 'pool') return undefined;
    const list = servers
      .list()
      .filter((s) => s.enabled && s.mode === 'provider' && s.allowed.length)
      .map((s) => ({ name: s.name, url: s.url, token: servers.token(s), allowed: s.allowed }));
    if (!list.length) return undefined;
    const base = target.provider === 'anthropic' ? createAnthropicWireAdapter({ serverFallbacks: true }) : getAdapter('openai');
    return (base && withProviderMcp(base, list)) || undefined;
  };
  setAdapterChooser((target) => chooseAdapter(target));

  /**
   * The registry as one turn's loop sees it: memory_lookup answers with the notes of that turn's
   * conversation (its project decides which).
   * @param {TurnContext} ctx
   * @returns {typeof registry}
   */
  const turnRegistry = (ctx) => ({ ...registry, get: (name) => (name === 'memory_lookup' ? memoryTool(ctx.conversationId) : registry.get(name)) });

  // Tool calls, and the check of a web answer.
  setToolRunner(async ({ result, request, ctx, signal, view }) => {
    /** @type {import('./hooks.js').ToolRunResult | null} */
    let out = null;
    if (result.stopReason === 'tool_call' && result.toolCalls.length) {
      const req = await request();
      const box = view ? activityBox(view.element) : null;
      const activity = box ? createToolActivity(box) : null;
      const loop = await runToolLoop({
        request: req,
        first: result,
        registry: turnRegistry(ctx),
        gate,
        signal,
        locale: ctx.locale,
        label: (key) => t(key),
        ask: box ? (r, s) => renderApprovalCard(box, r, s) : undefined,
        observer: {
          onText: (text) => view?.update(text),
          onToolStart: (call, title) => activity?.start(call.id, title),
          onToolEnd: (call, title, status) => activity?.finish(call.id, title, status === 'done' ? 'done' : status === 'forbidden' ? 'forbidden' : status === 'denied' ? 'denied' : 'failed'),
          onLimit: (rounds) => activity?.limit(rounds),
        },
        adapterFor: (r) => chooseAdapter({ provider: r.provider, model: r.model, route: routeOf(r.provider) }),
      });
      out = loop.result;
    }
    // The pack stays for answers written again from this turn (regenerate, compare columns); the
    // next question with the same words replaces it. An answer that marks nothing from it stays as
    // it is.
    const pack = packs.get(packKey(ctx));
    if (pack) out = verifiedWebAnswer(out ?? result, pack) ?? out;
    return out;
  });

  /** @type {Map<string, () => void>} */
  const menu = new Map();
  const renderMenu = () => {
    for (const entry of MENU) {
      menu.get(entry.id)?.();
      const on = entry.keys.every((k) => switches[k]);
      menu.set(entry.id, registerComposerTool({ id: entry.id, labelKey: on ? entry.on : entry.off, icon: on ? 'check' : entry.icon, run: () => api.setSwitches(Object.fromEntries(entry.keys.map((k) => [k, !on]))) }));
    }
    if (opts.openSettings && !menu.has('tools-settings')) menu.set('tools-settings', registerComposerTool({ id: 'tools-settings', labelKey: 'tools.menu.settings', icon: 'settings-2', run: opts.openSettings }));
  };

  const api = {
    registry,
    gate,
    servers,
    bridge,
    /** @returns {ToolSwitches} */
    switches: () => ({ ...switches }),
    /** @param {Partial<ToolSwitches>} patch */
    setSwitches(patch) {
      switches = readToolSwitches({ ...switches, ...patch });
      writeLocalJson(TOOL_SETTINGS_KEY, switches);
      renderMenu();
      changed();
    },
    /** @param {() => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Connects to the servers again and offers their approved tools. */
    syncServers: (/** @type {AbortSignal} */ signal) => bridge.sync(signal).finally(changed),
  };
  renderMenu();
  if (servers.list().some((s) => s.enabled && s.mode === 'browser')) void api.syncServers(AbortSignal.timeout(30_000)).catch(() => {});
  return api;
}

/** @typedef {ReturnType<typeof createRuntime>} ToolsRuntime */

/**
 * Installs the tools of the chat (once) and returns their runtime.
 * @param {{ openSettings?: () => void }} [opts]
 * @returns {ToolsRuntime}
 */
export function installChatTools(opts) {
  runtime ??= createRuntime(opts);
  return runtime;
}
