// @ts-check
// Knowledge graph: entities/relations from Supabase drawn on a canvas (text via fillText only).
import { submitChat } from './chat.js';
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

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 */
function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
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

  if (graph.entities.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px "Plus Jakarta Sans Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, emptyMessage ? emptyMessage() : t('graph.empty'), Math.max(160, width - 48));
    lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * 18));
    return;
  }

  const radius = Math.min(width, height) * 0.36;
  graph.entities.forEach((entity, idx) => {
    const angle = (idx / graph.entities.length) * 2 * Math.PI - Math.PI / 2;
    positions.set(entity.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });

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
    ctx.fillStyle = selected ? '#b45309' : '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(rel.relation_type, (src.x + tgt.x) / 2, (src.y + tgt.y) / 2 - 3);
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

    ctx.fillStyle = selected ? '#0f172a' : '#334155';
    ctx.font = `${selected ? 'bold ' : '600 '}11px "Plus Jakarta Sans Variable", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(entity.name, pos.x, pos.y + r + 5);
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

function closeEntityModal() {
  setHidden(byId('entityModal'), true);
  const name = /** @type {HTMLInputElement | null} */ (byId('newEntityName'));
  const desc = /** @type {HTMLTextAreaElement | null} */ (byId('newEntityDesc'));
  if (name) name.value = '';
  if (desc) desc.value = '';
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
  onAction('open-entity-modal', () => setHidden(byId('entityModal'), false));
  onAction('close-entity-modal', () => closeEntityModal());
  onAction('save-entity', () => saveEntity());
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEntityModal();
  });
}
