// @ts-check
// Knowledge graph: the entities and relations added by hand (Supabase) next to the ones found in the
// files of the workspace (graph-extract.js), drawn on a canvas (text via fillText only). What was
// found in files is drawn dashed, names the passages it comes from and stays on this device.
// Loaded with its tab (graph-tab.js), which also handles the tab's reload and new-entity buttons;
// the find-in-files controls are added here, so they exist once the view is there.
import { submitChat } from './chat.js';
import { closeDialog, openDialog } from './dialog.js';
import { byId, onAction, setHidden, setHtml } from './dom.js';
import { appModelRunner, createGraphStore, extractDocs, loadMergedGraph, needsReading, readDocChunks } from './graph-extract.js';
import { hasKey, onLocaleChange, setText, t } from './i18n/index.js';
import { describeDataError } from './library.js';
import { getDocumentText, listWorkspace, restoreWorkspace, workspaceStatus } from './rag/workspace.js';
import { escapeHtml } from './render.js';
import { getMode } from './state.js';
import { appDb } from './store/schema.js';
import { insertEntity, listEntities, listRelations } from './supabase.js';
import { switchTab } from './ui.js';

/** @typedef {import('./graph-extract.js').ViewEntity} Entity */
/** @typedef {import('./graph-extract.js').ViewRelation} Relation */
/** @typedef {import('./graph-extract.js').AutoSummary} AutoSummary */
/** @typedef {import('./graph-extract.js').ExtractReport} ExtractReport */
/** @typedef {{ kind: 'report', report: ExtractReport } | { kind: 'no_files' | 'up_to_date' | 'failed' }} FindOutcome */

const TYPE_COLORS = /** @type {Record<string, string>} */ ({
  project: '#0284c7',
  person: '#7c3aed',
  metric: '#059669',
  tech: '#d97706',
  regulation: '#dc2626',
  organization: '#0d9488',
  place: '#db2777',
  other: '#64748b',
});
/** The types the new-entity form offers. */
const ENTITY_TYPES = new Set(['project', 'person', 'metric', 'tech', 'regulation']);

/** @type {{ entities: Entity[], relations: Relation[] }} */
let graph = { entities: [], relations: [] };
/** @type {(() => string) | null} */
let emptyMessage = null;
/** @type {string | null} */
let selectedId = null;
/** @type {Map<string, { x: number, y: number }>} */
let positions = new Map();
/** What the loaded graph holds from files. @type {AutoSummary | null} */
let found = null;
/** The shared knowledge base gave nothing while files did. */
let sharedMissing = false;
/** The run reading the files, while one runs. @type {AbortController | null} */
let finding = null;
/** @type {{ done: number, total: number } | null} */
let progress = null;
/** How the last run on this page ended. @type {FindOutcome | null} */
let lastRun = null;

const store = createGraphStore({ openDb: appDb });

/**
 * The workspace documents, or null while they cannot be known (documents stored on this device that
 * the worker has not listed): then no result is dropped as stale.
 * @returns {Promise<import('./rag/workspace.js').WorkspaceDocument[] | null>}
 */
async function workspaceDocs() {
  await restoreWorkspace().catch(() => {});
  if (workspaceStatus().ready) return listWorkspace();
  try {
    const db = await appDb();
    if (db.persistent && (await db.count('docs')) > 0) return null;
  } catch {
    return null;
  }
  return listWorkspace();
}

export async function loadKnowledgeGraph() {
  const loader = byId('graphLoading');
  setHidden(loader, false);
  try {
    const merged = await loadMergedGraph({ listEntities, listRelations, store, docs: await workspaceDocs() });
    graph = { entities: merged.entities, relations: merged.relations };
    found = merged.summary;
    const error = merged.manualError;
    sharedMissing = Boolean(error) && graph.entities.length > 0;
    if (graph.entities.length > 0) emptyMessage = null;
    else emptyMessage = error ? () => describeDataError(error) : () => t('graph.empty');
    selectedId = null;
    showEntityDetails(null);
    renderGraph();
    renderFindStatus();
  } finally {
    setHidden(loader, true);
  }
}

/** The entities as buttons: the keyboard and screen-reader way into the graph. */
function renderEntityList() {
  const list = byId('graphEntityList');
  if (!list) return;
  setHidden(byId('graphEntityListLabel'), graph.entities.length === 0);
  // Rebuilding the list removes the focused button; keyboard focus returns to its replacement.
  const focused = list.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.arg : undefined;
  list.replaceChildren(
    ...graph.entities.map((entity) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'badge badge-muted hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900';
      btn.dataset.action = 'select-entity';
      btn.dataset.arg = entity.id;
      btn.setAttribute('aria-pressed', String(entity.id === selectedId));
      btn.textContent = entity.name;
      if (entity.origin === 'auto') {
        // Found in files: dashed like its node, and said in words for screen readers.
        btn.classList.add('border-dashed', 'border-slate-400');
        const marker = document.createElement('span');
        marker.className = 'sr-only';
        marker.textContent = ` (${t('graph.found_marker')})`;
        btn.append(marker);
      }
      li.append(btn);
      return li;
    }),
  );
  if (focused !== undefined) /** @type {HTMLElement | null} */ (list.querySelector(`button[data-arg="${CSS.escape(focused)}"]`))?.focus();
}

/** @param {Relation} rel */
const relationLabel = (rel) => (rel.kind === 'cooccurrence' ? t('graph.cooccurs') : rel.relation_type);

export function renderGraph() {
  const canvas = /** @type {HTMLCanvasElement | null} */ (byId('graphCanvas'));
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  if (!ctx || rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { width, height } = rect;
  const cx = width / 2;
  const cy = height / 2;
  ctx.clearRect(0, 0, width, height);
  positions = new Map();

  renderEntityList();
  // Empty and error states are text in the DOM (announced, translatable), not canvas pixels.
  const status = byId('graphStatus');
  if (graph.entities.length === 0) {
    if (status) status.textContent = emptyMessage ? emptyMessage() : t('graph.empty');
    setHidden(status, false);
    return;
  }
  setHidden(status, true);

  const radius = Math.min(width, height) * 0.36;
  graph.entities.forEach((entity, idx) => {
    const angle = (idx / graph.entities.length) * 2 * Math.PI - Math.PI / 2;
    positions.set(entity.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });

  // Space taken by nodes and their names; relation labels are placed around it and each other.
  /** @type {Array<{ x: number, y: number, w: number, h: number }>} */
  const taken = [];
  const overlaps = (/** @type {{ x: number, y: number, w: number, h: number }} */ b) =>
    taken.some((p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y);
  for (const entity of graph.entities) {
    const pos = positions.get(entity.id);
    if (!pos) continue;
    const pad = selectedId === entity.id ? 28 : 22;
    taken.push({ x: pos.x - pad, y: pos.y - pad, w: 2 * pad, h: 2 * pad });
  }
  // Names go below their node, or above it when that space is taken, or shortened below it.
  /** @type {Map<string, { text: string, y: number }>} */
  const names = new Map();
  const nameOrder = [...graph.entities].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
  for (const entity of nameOrder) {
    const pos = positions.get(entity.id);
    if (!pos) continue;
    const selected = selectedId === entity.id;
    const r = selected ? 22 : 18;
    ctx.font = `${selected ? 'bold ' : '600 '}11px "Plus Jakarta Sans Variable", sans-serif`;
    const boxFor = (/** @type {string} */ text, /** @type {number} */ y) => {
      const w = ctx.measureText(text).width + 4;
      return { x: pos.x - w / 2, y: y - 1, w, h: 15 };
    };
    const below = pos.y + r + 5;
    const above = pos.y - r - 18;
    /** @type {{ text: string, y: number } | null} */
    let placed = null;
    // The longest text that fits, below the node or else above it.
    for (let n = entity.name.length; !placed && n >= Math.min(6, entity.name.length); n -= 1) {
      const text = n === entity.name.length ? entity.name : `${entity.name.slice(0, n).trimEnd()}…`;
      for (const y of [below, above]) {
        if (!overlaps(boxFor(text, y))) {
          placed = { text, y };
          break;
        }
      }
    }
    placed ??= { text: entity.name, y: below };
    taken.push(boxFor(placed.text, placed.y));
    names.set(entity.id, placed);
  }

  // Relations found in files are dashed; a co-occurrence is labelled only while one of its ends is
  // selected (it says no more than "appears with").
  /** @type {Array<{ label: string, src: { x: number, y: number }, tgt: { x: number, y: number }, selected: boolean }>} */
  const edges = [];
  for (const rel of graph.relations) {
    const src = positions.get(rel.source_entity_id);
    const tgt = positions.get(rel.target_entity_id);
    if (!src || !tgt) continue;
    const selected = selectedId === rel.source_entity_id || selectedId === rel.target_entity_id;
    const auto = rel.origin === 'auto';
    ctx.strokeStyle = selected ? '#d97706' : auto ? '#cbd5e1' : '#e2e8f0';
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(auto ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (rel.kind !== 'cooccurrence' || selected) edges.push({ label: relationLabel(rel), src, tgt, selected });
  }

  // Labels sit on a pill so crossing lines do not run through them. With a node selected only its
  // relations are labelled; a label that would cover another one or a node is left out (every
  // relation is listed in the entity details).
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const edge of edges.sort((a, b) => Number(b.selected) - Number(a.selected))) {
    if (selectedId && !edge.selected) continue;
    const w = ctx.measureText(edge.label).width + 8;
    const h = 14;
    for (const f of [0.5, 0.38, 0.62]) {
      const x = edge.src.x + (edge.tgt.x - edge.src.x) * f;
      const y = edge.src.y + (edge.tgt.y - edge.src.y) * f;
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      if (overlaps(box)) continue;
      taken.push(box);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = edge.selected ? '#fcd34d' : '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
      ctx.fillStyle = edge.selected ? '#92400e' : '#475569';
      ctx.fillText(edge.label, x, y + 0.5);
      break;
    }
  }

  for (const entity of graph.entities) {
    const pos = positions.get(entity.id);
    if (!pos) continue;
    const selected = selectedId === entity.id;
    const color = TYPE_COLORS[entity.entity_type] ?? '#0284c7';
    const r = selected ? 22 : 18;
    if (selected) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 6, 0, 2 * Math.PI);
      ctx.fillStyle = `${color}25`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = selected ? '#FFCA00' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = selected ? '#d97706' : color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(entity.origin === 'auto' ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = selected ? '#0f172a' : color;
    ctx.font = 'bold 11px "Plus Jakarta Sans Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entity.name.slice(0, 2).toUpperCase(), pos.x, pos.y);

    const name = names.get(entity.id) ?? { text: entity.name, y: pos.y + r + 5 };
    ctx.font = `${selected ? 'bold ' : '600 '}11px "Plus Jakarta Sans Variable", sans-serif`;
    ctx.textBaseline = 'top';
    // A halo keeps the name readable where a relation line passes behind it.
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.95)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(name.text, pos.x, name.y);
    ctx.fillStyle = selected ? '#0f172a' : '#334155';
    ctx.fillText(name.text, pos.x, name.y);
  }
}

/**
 * Where a relation found in files comes from: "file, passage n" for each cited chunk.
 * @param {Relation} rel
 */
function citesOf(rel) {
  return (rel.cites ?? []).map((c) => t('graph.cite', { doc: c.docName, chunk: c.chunk + 1 })).join(' · ');
}

/** @param {Entity} entity */
function originLine(entity) {
  const key = `graph.origin_${entity.origin}`;
  const docs = entity.docs.map((id) => found?.docNames[id]).filter((n) => typeof n === 'string');
  const where = docs.length ? `<span class="block">${escapeHtml(t('graph.found_in', { docs: docs.join(', ') }))}</span>` : '';
  const icon = entity.origin === 'manual' ? '<i data-lucide="user" class="w-3.5 h-3.5 flex-shrink-0 mt-px"></i>' : '<i data-lucide="file-text" class="w-3.5 h-3.5 flex-shrink-0 mt-px"></i>';
  return `<p class="text-[11px] text-slate-500 flex items-start gap-1.5">${icon}<span><span data-i18n="${key}">${escapeHtml(t(key))}</span>${where}</span></p>`;
}

/** @param {Entity | null} entity */
function showEntityDetails(entity) {
  const box = byId('entityDetailContent');
  const badge = byId('selectedEntityBadge');
  if (!box || !badge) return;
  if (!entity) {
    setText(badge, 'graph.details_badge');
    setHtml(
      box,
      `<div class="text-center py-12 text-slate-500">
        <i data-lucide="mouse-pointer-click" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
        <p data-i18n="graph.details_empty">${escapeHtml(t('graph.details_empty'))}</p>
      </div>`,
    );
    return;
  }

  const typeKey = `graph.type_${entity.entity_type}`;
  if (hasKey(typeKey)) setText(badge, typeKey);
  else {
    badge.removeAttribute('data-i18n');
    badge.textContent = entity.entity_type;
  }
  const outgoing = graph.relations.filter((r) => r.source_entity_id === entity.id);
  const incoming = graph.relations.filter((r) => r.target_entity_id === entity.id);
  const nameOf = (/** @type {string} */ id, /** @type {string} */ fallback) => graph.entities.find((e) => e.id === id)?.name ?? fallback;
  const edge = (/** @type {'outgoing' | 'incoming'} */ dir, /** @type {string} */ name, /** @type {Relation} */ rel) => {
    const cites = citesOf(rel);
    return `
    <div class="p-2.5 rounded-lg bg-white border ${rel.origin === 'auto' ? 'border-dashed border-slate-300' : 'border-slate-200'} text-xs space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-slate-800 font-medium flex items-center gap-1.5 min-w-0">
          <i data-lucide="${dir === 'outgoing' ? 'arrow-right' : 'arrow-left'}" class="w-3.5 h-3.5 flex-shrink-0 text-slate-400"></i>
          <span class="sr-only" data-i18n="graph.${dir}">${escapeHtml(t(`graph.${dir}`))}</span>
          <span class="truncate">${escapeHtml(name)}</span>
        </span>
        <span class="badge badge-brand">${escapeHtml(relationLabel(rel))}</span>
      </div>
      ${rel.quote ? `<p class="text-slate-600 leading-relaxed"><q>${escapeHtml(rel.quote)}</q></p>` : ''}
      ${cites ? `<p class="text-[11px] text-slate-500">${escapeHtml(cites)}</p>` : ''}
    </div>`;
  };

  setHtml(
    box,
    `<div class="p-3.5 rounded-xl bg-white border ${entity.origin === 'auto' ? 'border-dashed border-slate-300' : 'border-slate-200'} space-y-2 shadow-xs">
      <div class="flex items-center gap-2">
        <span class="entity-swatch w-3 h-3 rounded-full"></span>
        <h4 class="text-sm font-bold text-slate-900">${escapeHtml(entity.name)}</h4>
      </div>
      ${entity.origin === 'auto' ? '' : `<p class="text-xs text-slate-600 leading-relaxed">${entity.description ? escapeHtml(entity.description) : `<span data-i18n="graph.no_description">${escapeHtml(t('graph.no_description'))}</span>`}</p>`}
      ${originLine(entity)}
    </div>
    <div class="space-y-2">
      <h5 class="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
        <i data-lucide="git-fork" class="w-3.5 h-3.5 text-amber-600"></i>
        <span data-i18n="graph.connections" data-i18n-params="${escapeHtml(JSON.stringify({ n: outgoing.length + incoming.length }))}">${escapeHtml(t('graph.connections', { n: outgoing.length + incoming.length }))}</span>
      </h5>
      <div class="space-y-1.5">
        ${outgoing.map((r) => edge('outgoing', nameOf(r.target_entity_id, t('graph.unknown_entity')), r)).join('')}
        ${incoming.map((r) => edge('incoming', nameOf(r.source_entity_id, t('graph.unknown_entity')), r)).join('')}
        ${outgoing.length === 0 && incoming.length === 0 ? `<p class="text-slate-500 text-xs italic" data-i18n="graph.no_edges">${escapeHtml(t('graph.no_edges'))}</p>` : ''}
      </div>
    </div>
    <button type="button" data-action="ask-entity" data-arg="${escapeHtml(entity.name)}"${entity.origin === 'auto' ? ' data-scope="files"' : ''} class="btn btn-primary w-full justify-center">
      <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
      <span data-i18n="graph.ask" data-i18n-params="${escapeHtml(JSON.stringify({ name: entity.name }))}">${escapeHtml(t('graph.ask', { name: entity.name }))}</span>
    </button>`,
  );
  const swatch = /** @type {HTMLElement | null} */ (box.querySelector('.entity-swatch'));
  if (swatch) swatch.style.backgroundColor = TYPE_COLORS[entity.entity_type] ?? '#0284c7';
}

/** @param {string} id */
function selectEntity(id) {
  selectedId = id;
  renderGraph();
  showEntityDetails(graph.entities.find((e) => e.id === id) ?? null);
}

function clearEntityForm() {
  const name = /** @type {HTMLInputElement | null} */ (byId('newEntityName'));
  const desc = /** @type {HTMLTextAreaElement | null} */ (byId('newEntityDesc'));
  if (name) name.value = '';
  if (desc) desc.value = '';
}

/**
 * Opens the new-entity dialog.
 * @param {HTMLElement} trigger
 */
export function openEntityModal(trigger) {
  openDialog(byId('entityModal'), { trigger, initialFocus: byId('newEntityName'), onClose: clearEntityForm });
}

function closeEntityModal() {
  // The form is cleared by onClose, also when Escape closes the dialog.
  closeDialog(byId('entityModal'));
}

async function saveEntity() {
  const name = /** @type {HTMLInputElement | null} */ (byId('newEntityName'))?.value.trim().slice(0, 200) ?? '';
  const typeValue = /** @type {HTMLSelectElement | null} */ (byId('newEntityType'))?.value ?? 'project';
  const description = /** @type {HTMLTextAreaElement | null} */ (byId('newEntityDesc'))?.value.trim().slice(0, 2_000) ?? '';
  if (!name) {
    window.alert(t('graph.name_required'));
    return;
  }
  const res = await insertEntity({ name, entityType: ENTITY_TYPES.has(typeValue) ? typeValue : 'project', description });
  if (!res.ok) {
    window.alert(`${t('graph.save_failed')} ${describeDataError(res.error)}`);
    return;
  }
  closeEntityModal();
  await loadKnowledgeGraph();
}

// ---------------------------------------------------------------------------------------------
// Finding entities in files
// ---------------------------------------------------------------------------------------------

/** Adds the find button next to the tab's reload button and the legend and status above the canvas. */
function installFindControls() {
  const reload = document.querySelector('#tab-graph [data-action="reload-graph"]');
  if (reload && !byId('graphFindBtn')) {
    const holder = document.createElement('div');
    setHtml(
      holder,
      `<button type="button" id="graphFindBtn" data-action="find-in-files" class="btn btn-secondary" data-i18n-title="graph.find_hint" title="${escapeHtml(t('graph.find_hint'))}">
        <i data-lucide="network" class="w-3.5 h-3.5"></i>
        <span data-i18n="graph.find">${escapeHtml(t('graph.find'))}</span>
      </button>`,
    );
    reload.parentElement?.classList.add('flex-wrap');
    reload.before(...holder.childNodes);
  }
  const area = byId('graphCanvas')?.parentElement;
  if (area && !byId('graphFound')) {
    const bar = document.createElement('div');
    bar.id = 'graphFound';
    bar.className = 'mb-3 space-y-1.5';
    setHtml(
      bar,
      `<div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-700 font-medium">
        <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-slate-500"></span><span data-i18n="graph.legend_manual">${escapeHtml(t('graph.legend_manual'))}</span></span>
        <span class="flex items-center gap-1.5"><span class="w-4 border-t-2 border-dashed border-slate-500"></span><span data-i18n="graph.legend_auto">${escapeHtml(t('graph.legend_auto'))}</span></span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <p id="graphFoundStatus" role="status" class="flex-1 min-w-[12rem] text-[11px] text-slate-600 leading-relaxed"></p>
        <button type="button" id="graphFindStop" data-action="stop-find-in-files" class="btn btn-ghost hidden">
          <i data-lucide="square" class="w-3.5 h-3.5"></i>
          <span data-i18n="graph.stop">${escapeHtml(t('graph.stop'))}</span>
        </button>
        <button type="button" id="graphFoundClear" data-action="clear-found-in-files" class="btn btn-ghost hidden">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          <span data-i18n="graph.clear_found">${escapeHtml(t('graph.clear_found'))}</span>
        </button>
      </div>`,
    );
    area.before(bar);
  }
}

/** The status line about what was found in files. */
function findStatusText() {
  if (finding) return progress ? t('graph.status_reading', { done: progress.done, total: progress.total }) : t('graph.status_preparing');
  if (lastRun?.kind === 'no_files') return t('graph.status_no_files');
  /** @type {string[]} */
  const parts = [];
  if (lastRun?.kind === 'failed') parts.push(t('graph.status_failed'));
  if (lastRun?.kind === 'up_to_date') parts.push(t('graph.status_up_to_date'));
  if (lastRun?.kind === 'report' && lastRun.report.cancelled) parts.push(t('graph.status_cancelled'));
  if (lastRun?.kind === 'report' && lastRun.report.deferred) parts.push(t('graph.status_deferred', { n: lastRun.report.deferred }));
  if (found && found.docs > 0) {
    parts.push(t('graph.status_summary', { docs: found.docs, entities: found.entities, relations: found.relations }));
    const { model, cooccurrence, mixed } = found.modes;
    parts.push(t(mixed || (model && cooccurrence) ? 'graph.status_mode_mixed' : model ? 'graph.status_mode_model' : 'graph.status_mode_cooccurrence'));
    if (found.dropped.relations) parts.push(t('graph.status_dropped', { n: found.dropped.relations }));
    if (found.hidden) parts.push(t('graph.status_limited', { n: found.hidden }));
    if (sharedMissing) parts.push(t('graph.status_shared_missing'));
  } else if (!parts.length) {
    parts.push(t('graph.status_idle'));
  }
  return parts.join(' ');
}

function renderFindStatus() {
  const status = byId('graphFoundStatus');
  if (!status) return;
  const find = byId('graphFindBtn');
  if (find instanceof HTMLButtonElement) {
    find.disabled = Boolean(finding);
    find.setAttribute('aria-busy', String(Boolean(finding)));
  }
  setHidden(byId('graphFindStop'), !finding);
  setHidden(byId('graphFoundClear'), Boolean(finding) || !found?.docs);
  status.textContent = findStatusText();
}

/**
 * Reads the workspace documents that have no current result. A model reads them when one is set up
 * (after the user agreed, when passages would leave this device); in on-device mode or offline only
 * a model on this device may, and without one names that appear together are linked.
 * @param {AbortSignal} signal
 * @returns {Promise<FindOutcome | null>}  null: the user declined
 */
async function runFind(signal) {
  await restoreWorkspace();
  const docs = listWorkspace().filter((d) => d.chunks > 0);
  if (!docs.length) return { kind: 'no_files' };
  const deviceOnly = getMode() === 'client' || navigator.onLine === false;
  const runner = await appModelRunner({ deviceOnly }).catch(() => null);
  const stored = new Map((await store.load()).map((g) => [g.docId, g]));
  const pending = docs.filter((d) => needsReading(d, stored.get(d.docId), Boolean(runner)));
  if (!pending.length) return { kind: 'up_to_date' };
  if (runner?.leavesDevice && !window.confirm(t('graph.confirm_model', { n: pending.length }))) return null;
  /** @type {Array<{ docId: string, name: string, textSha256: string, chunks: import('./graph-extract.js').GraphChunk[] }>} */
  const withChunks = [];
  for (const d of pending) {
    if (signal.aborted) break;
    const chunks = await readDocChunks(d, { openDb: appDb, text: getDocumentText });
    if (chunks.length) withChunks.push({ docId: d.docId, name: d.name, textSha256: d.textSha256, chunks });
  }
  const report = await extractDocs(withChunks, {
    run: runner?.run ?? null,
    signal,
    onProgress: (p) => {
      progress = p;
      renderFindStatus();
    },
  });
  if (signal.aborted) report.cancelled = true;
  // Kept on this device like the files: in memory only when the user chose that.
  const ws = workspaceStatus();
  await store.save(report.graphs, { persist: ws.persistent && ws.keep !== false });
  return { kind: 'report', report };
}

async function findInFiles() {
  if (finding) return;
  const controller = new AbortController();
  finding = controller;
  progress = null;
  lastRun = null;
  renderFindStatus();
  try {
    lastRun = await runFind(controller.signal);
  } catch (err) {
    console.warn('[starpi] reading the files for the knowledge graph failed', err);
    lastRun = { kind: 'failed' };
  } finally {
    finding = null;
    progress = null;
  }
  await loadKnowledgeGraph();
}

async function clearFound() {
  if (finding || !window.confirm(t('graph.clear_confirm'))) return;
  await store.clear();
  lastRun = null;
  await loadKnowledgeGraph();
}

export function initGraph() {
  installFindControls();
  renderFindStatus();
  onAction('close-entity-modal', () => closeEntityModal());
  onAction('save-entity', () => saveEntity());
  onAction('select-entity', (el) => selectEntity(el.dataset.arg ?? ''));
  onAction('find-in-files', () => findInFiles());
  onAction('stop-find-in-files', () => finding?.abort());
  onAction('clear-found-in-files', () => clearFound());
  onAction('ask-entity', (el) => {
    switchTab('chat');
    // A question about an entity of the knowledge base: always answered from the sources and
    // checked. One found only in the files on this device is looked up in those files.
    return submitChat(t('graph.ask_prompt', { name: el.dataset.arg ?? '' }), { chatMode: 'grounded', ...(el.dataset.scope === 'files' ? { workspaceOnly: true } : {}) });
  });

  const canvas = byId('graphCanvas');
  canvas?.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (const [id, pos] of positions) {
      if (Math.hypot(pos.x - x, pos.y - y) <= 25) {
        selectEntity(id);
        return;
      }
    }
    selectedId = null;
    renderGraph();
    showEntityDetails(null);
  });

  onLocaleChange(() => {
    renderFindStatus();
    if (byId('tab-graph')?.classList.contains('hidden')) return;
    renderGraph();
    // The details hold relation labels and passage names written in the old language.
    if (selectedId) showEntityDetails(graph.entities.find((e) => e.id === selectedId) ?? null);
  });
  window.addEventListener('resize', () => {
    if (!byId('tab-graph')?.classList.contains('hidden')) renderGraph();
  });
}
