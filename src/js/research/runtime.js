// @ts-check
// The app's side of a research job (deep.js ResearchRuntime) in the browser: which model serves
// (keys and catalog of the AI layer, the site's offer from GET /api/health), the research step on
// the site's pool, workspace and library search for the tools, and the artifact store for reports.
// Everything here is loaded with the Research feature, never with the first page.
import { getHealth, loadHealth } from '../ai/health-client.js';
import { complete, listAdapters } from '../ai/index.js';
import { ACCESS_SLOT, getKey, hasKey, keysReady } from '../ai/keys.js';
import { capsFor, roleModel } from '../ai/catalog/models.js';
import { getProvider, PROVIDER_ORDER } from '../ai/catalog/providers.js';
import { selectedModel } from '../ai/model-selection.js';
import { ACCESS_HEADER } from '../ai/transport.js';
import { LIMITS } from '../config.js';
import { listWorkspace, searchWorkspace } from '../rag/workspace.js';
import { mergeHits, workspaceHit } from '../retrieval.js';
import { appDb } from '../store/schema.js';
import { getConnection, listDocuments, searchKnowledge } from '../supabase.js';

/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('./deep.js').ResearchRuntime} ResearchRuntime */
/** @typedef {import('./deep.js').ModelChoice} ModelChoice */
/** @typedef {import('./sources-part.js').StepAnswer} StepAnswer */
/** @typedef {import('../core/receipt.js').ReceiptDocument} ReceiptDocument */

/** Where the research step lives. */
export const STEP_URL = '/api/research/step';
/** Cloud providers a web search is tried on, in this order (Gemini's search is the default). */
const WEB_ORDER = /** @type {readonly ProviderId[]} */ (['gemini', 'anthropic', 'openai', 'xai', 'openrouter']);

/** An error of the research step, with the server's code. */
export class StepError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   */
  constructor(code, status) {
    super(`research step: ${code}`);
    this.code = code;
    this.status = status;
  }
}

/**
 * The model a provider serves for research: the person's choice there, else the catalog's balanced
 * candidate.
 * @param {ProviderId} provider
 * @returns {string | null}
 */
function modelAt(provider) {
  return selectedModel(provider)?.model ?? roleModel(provider, 'balanced') ?? roleModel(provider, 'max') ?? null;
}

/**
 * The first provider with the person's key whose model does what `needs` asks.
 * @param {readonly ProviderId[]} order
 * @param {(caps: import('../ai/contract.js').Caps) => boolean} needs
 * @returns {ModelChoice | null}
 */
function firstWith(order, needs) {
  for (const provider of order) {
    const info = getProvider(provider);
    if (!info || info.auth === 'none' || !hasKey(provider) || !listAdapters().includes(provider)) continue;
    const model = modelAt(provider);
    if (model && needs(capsFor(provider, model))) return { provider, model };
  }
  return null;
}

/**
 * POST /api/research/step with the site's access code.
 * @param {Record<string, unknown>} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<StepAnswer>}
 */
export async function postStep(body, signal) {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  const code = (getKey(ACCESS_SLOT) ?? '').trim();
  if (code) headers[ACCESS_HEADER] = code;
  const res = await fetch(STEP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    /** @type {unknown} */
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Not JSON: a host without the site's functions.
    }
    const error = /** @type {{ error?: unknown }} */ (data ?? {}).error;
    throw new StepError(typeof error === 'string' ? error : `http_${res.status}`, res.status);
  }
  return /** @type {StepAnswer} */ (await res.json());
}

/**
 * Workspace and library hits for a query, merged so neither crowds out the other.
 * @param {string} query
 * @param {number} k
 */
async function searchSources(query, k) {
  const [local, remote] = await Promise.all([
    searchWorkspace(query, k)
      .then((hits) => hits.map(workspaceHit))
      .catch(() => []),
    getConnection().status === 'offline' ? Promise.resolve([]) : searchKnowledge(query, Math.min(k, LIMITS.retrievalRows)).then((r) => (r.ok ? r.data : [])),
  ]);
  return mergeHits(local, remote, k);
}

/** Names of the documents on this device and in the library. */
async function documentNames() {
  const local = listWorkspace().map((d) => d.name);
  if (getConnection().status === 'offline') return local;
  const res = await listDocuments();
  return [...local, ...(res.ok ? res.data.map((d) => d.title) : [])];
}

/**
 * The receipt facts of a workspace document.
 * @param {string} docId
 * @returns {ReceiptDocument | undefined}
 */
export function documentInfo(docId) {
  const doc = listWorkspace().find((d) => d.docId === docId);
  if (!doc) return undefined;
  return { name: doc.name, kind: doc.kind, bytes: doc.bytes, fileSha256: doc.fileSha256, textSha256: doc.textSha256, textChars: doc.chars, pages: doc.pages, extractor: doc.extractor, chunker: doc.chunker };
}

/**
 * Stores a report as an artifact; a report written again becomes a new version of it.
 * @param {import('../store/schema.js').ArtifactRecord & Record<string, unknown>} artifact
 */
async function saveArtifact(artifact) {
  const db = await appDb();
  const before = /** @type {import('../store/schema.js').ArtifactRecord | undefined} */ (await db.get('artifacts', artifact.id));
  const versions = [...(before?.versions ?? []), ...artifact.versions].slice(-10);
  await db.put('artifacts', { ...artifact, versions });
}

/**
 * The report of a job as stored, newest version.
 * @param {string} artifactId
 * @returns {Promise<string | null>}
 */
export async function loadReport(artifactId) {
  try {
    const db = await appDb();
    const record = /** @type {import('../store/schema.js').ArtifactRecord | undefined} */ (await db.get('artifacts', artifactId));
    return record?.versions.at(-1)?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * The runtime of research jobs in this browser.
 * @returns {ResearchRuntime}
 */
export function browserRuntime() {
  return {
    complete,
    step: postStep,
    backends: { search: searchSources, documents: documentNames },
    async routes() {
      await keysReady().catch(() => {});
      const health = getHealth().data ?? (await loadHealth().catch(() => null))?.data ?? null;
      return {
        sources: firstWith(PROVIDER_ORDER, (caps) => caps.tools),
        web: firstWith(WEB_ORDER, (caps) => caps.search !== 'none'),
        pool: health?.research === true,
      };
    },
    saveArtifact,
    now: () => Date.now(),
  };
}
