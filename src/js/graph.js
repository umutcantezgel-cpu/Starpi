// @ts-check
// Knowledge graph: entities/relations from Supabase drawn on a canvas (text via fillText only).
import { submitChat } from './chat.js';
import { closeDialog, openDialog } from './dialog.js';
import { byId, onAction, setHidden, setHtml } from './dom.js';
import { hasKey, onLocaleChange, setText, t } from './i18n/index.js';
import { describeDataError } from './library.js';
import { escapeHtml } from './render.js';
import { insertEntity, listEntities, listRelations } from './supabase.js';
import { switchTab } from './ui.js';

/** @typedef {{ id: string, name: string, entity_type: string, description: string | null }} Entity */
/** @typedef {{ source_entity_id: string, target_entity_id: string, relation_type: string }} Relation */

const TYPE_COLORS = /** @type {Record<string, string>} */ ({
  project: '#0284c7',
  person: '#7c3aed',
  metric: '#059669',
  tech: '#d97706',
  regulation: '#dc2626',
});
const ENTITY_TYPES = new Set(Object.keys(TYPE_COLORS));

/** @type {{ entities: Entity[], relations: Relation[] }} */
let graph = { entities: [], relations: [] };
/** @type {(() => string) | null} */
let emptyMessage = null;
/** @type {string | null} */
let selectedId = null;
/** @type {Map<string, { x: number, y: number }>} */
let positions = new Map();

export async function loadKnowledgeGraph() {
  const loader = byId('graphLoading');
  setHidden(loader, false);
  try {
    const [entRes, relRes] = await Promise.all([listEntities(), listRelations()]);
    if (!entRes.ok) {
      graph = { entities: [], relations: [] };
      const error = entRes.error;
      emptyMessage = () => describeDataError(error);
    } else {
      graph = { entities: entRes.data ?? [], relations: relRes.ok ? (relRes.data ?? []) : [] };
      emptyMessage = graph.entities.length === 0 ? () => t('graph.empty') : null;
    }
    selectedId = null;
    showEntityDetails(null);
    renderGraph();
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
      li.append(btn);
      return li;
    }),
  );
  if (focused !== undefined) /** @type {HTMLElement | null} */ (list.querySelector(`button[data-arg="${CSS.escape(focused)}"]`))?.focus();
}

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

  /** @type {Array<{ label: string, src: { x: number, y: number }, tgt: { x: number, y: number }, selected: boolean }>} */
  const edges = [];
  for (const rel of graph.relations) {
    const src = positions.get(rel.source_entity_id);
    const tgt = positions.get(rel.target_entity_id);
    if (!src || !tgt) continue;
    const selected = selectedId === rel.source_entity_id || selectedId === rel.target_entity_id;
    ctx.strokeStyle = selected ? '#d97706' : '#e2e8f0';
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();
    edges.push({ label: rel.relation_type, src, tgt, selected });
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
    ctx.stroke();

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
  const edge = (/** @type {'outgoing' | 'incoming'} */ dir, /** @type {string} */ name, /** @type {string} */ type) => `
    <div class="p-2.5 rounded-lg bg-white border border-slate-200 text-xs flex items-center justify-between gap-2">
      <span class="text-slate-800 font-medium flex items-center gap-1.5 min-w-0">
        <i data-lucide="${dir === 'outgoing' ? 'arrow-right' : 'arrow-left'}" class="w-3.5 h-3.5 flex-shrink-0 text-slate-400"></i>
        <span class="sr-only" data-i18n="graph.${dir}">${escapeHtml(t(`graph.${dir}`))}</span>
        <span class="truncate">${escapeHtml(name)}</span>
      </span>
      <span class="badge badge-brand">${escapeHtml(type)}</span>
    </div>`;

  setHtml(
    box,
    `<div class="p-3.5 rounded-xl bg-white border border-slate-200 space-y-2 shadow-xs">
      <div class="flex items-center gap-2">
        <span class="entity-swatch w-3 h-3 rounded-full"></span>
        <h4 class="text-sm font-bold text-slate-900">${escapeHtml(entity.name)}</h4>
      </div>
      <p class="text-xs text-slate-600 leading-relaxed">${entity.description ? escapeHtml(entity.description) : `<span data-i18n="graph.no_description">${escapeHtml(t('graph.no_description'))}</span>`}</p>
    </div>
    <div class="space-y-2">
      <h5 class="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
        <i data-lucide="git-fork" class="w-3.5 h-3.5 text-amber-600"></i>
        <span data-i18n="graph.connections" data-i18n-params="${escapeHtml(JSON.stringify({ n: outgoing.length + incoming.length }))}">${escapeHtml(t('graph.connections', { n: outgoing.length + incoming.length }))}</span>
      </h5>
      <div class="space-y-1.5">
        ${outgoing.map((r) => edge('outgoing', nameOf(r.target_entity_id, t('graph.unknown_entity')), r.relation_type)).join('')}
        ${incoming.map((r) => edge('incoming', nameOf(r.source_entity_id, t('graph.unknown_entity')), r.relation_type)).join('')}
        ${outgoing.length === 0 && incoming.length === 0 ? `<p class="text-slate-500 text-xs italic" data-i18n="graph.no_edges">${escapeHtml(t('graph.no_edges'))}</p>` : ''}
      </div>
    </div>
    <button type="button" data-action="ask-entity" data-arg="${escapeHtml(entity.name)}" class="btn btn-primary w-full justify-center">
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

export function initGraph() {
  onAction('reload-graph', () => loadKnowledgeGraph());
  onAction('open-entity-modal', (el) => openDialog(byId('entityModal'), { trigger: el, initialFocus: byId('newEntityName'), onClose: clearEntityForm }));
  onAction('close-entity-modal', () => closeEntityModal());
  onAction('save-entity', () => saveEntity());
  onAction('select-entity', (el) => selectEntity(el.dataset.arg ?? ''));
  onAction('ask-entity', (el) => {
    switchTab('chat');
    return submitChat(t('graph.ask_prompt', { name: el.dataset.arg ?? '' }));
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
    if (!byId('tab-graph')?.classList.contains('hidden')) renderGraph();
  });
  window.addEventListener('resize', () => {
    if (!byId('tab-graph')?.classList.contains('hidden')) renderGraph();
  });
}
