// @ts-check
// Answer receipts in the app: every answer with citations keeps a receipt draft in memory (never
// stored), and the receipt dialog downloads it as JSON or verifies a receipt against original
// files. Everything shown here is set with textContent; receipts and files are read on this device.
import { buildReceipt, RECEIPT_LIMITS } from '../core/receipt.js';
import { closeDialog, openDialog } from '../dialog.js';
import { byId, onAction, setHidden } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { formatNumber, setText } from '../i18n/index.js';
import { verifyReceiptFiles } from './workspace.js';

/** @typedef {import('../core/receipt.js').ReceiptDraft} ReceiptDraft */
/** @typedef {import('../core/receipt.js').VerifyReport} VerifyReport */

const MAX_DRAFTS = 50;
/** @type {Map<string, ReceiptDraft>} */
const drafts = new Map();
let seq = 0;
/** @type {string | null} */
let current = null;
let buildSeq = 0;

/**
 * Keeps a receipt draft for an answer and returns its id.
 * @param {ReceiptDraft} draft
 */
export function storeReceiptDraft(draft) {
  const id = `r${++seq}`;
  drafts.set(id, draft);
  if (drafts.size > MAX_DRAFTS) drafts.delete(/** @type {string} */ (drafts.keys().next().value));
  return id;
}

/** @param {string} id */
export function receiptButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost px-2 py-1 text-[11px] mt-2';
  btn.dataset.action = 'open-receipt';
  btn.dataset.arg = id;
  const icon = document.createElement('i');
  icon.dataset.lucide = 'receipt';
  icon.className = 'w-3.5 h-3.5';
  const label = document.createElement('span');
  setText(label, 'receipt.button');
  btn.append(icon, label);
  return btn;
}

function options() {
  return {
    includeQuestion: /** @type {HTMLInputElement | null} */ (byId('receiptIncludeQuestion'))?.checked ?? true,
    includeExcerpts: /** @type {HTMLInputElement | null} */ (byId('receiptIncludeExcerpts'))?.checked ?? true,
  };
}

/** Shows the id and contents of the receipt the current options produce. */
async function preview() {
  const draft = current ? drafts.get(current) : undefined;
  if (!draft) return;
  const run = ++buildSeq;
  const receipt = await buildReceipt(draft, options());
  if (run !== buildSeq) return;
  const idEl = byId('receiptId');
  if (idEl) idEl.textContent = receipt.id.slice(0, 16);
  const workspace = receipt.citations.filter((c) => c.source === 'workspace').length;
  setText(byId('receiptCounts'), 'receipt.counts', { workspace: formatNumber(workspace), knowledge: formatNumber(receipt.citations.length - workspace) });
}

/**
 * @param {'export' | 'verify'} mode
 * @param {HTMLElement} trigger
 */
function openReceiptDialog(mode, trigger) {
  const modal = byId('receiptModal');
  if (!modal) return;
  setHidden(byId('receiptExport'), mode !== 'export');
  setText(byId('receiptModalTitle'), mode === 'export' ? 'receipt.title' : 'receipt.verify_title');
  byId('receiptVerifyResult')?.replaceChildren();
  openDialog(modal, { trigger, initialFocus: modal.querySelector('[data-action="close-receipt"]') });
}

async function download() {
  const draft = current ? drafts.get(current) : undefined;
  if (!draft) return;
  const receipt = await buildReceipt(draft, options());
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `starpi-receipt-${receipt.id.slice(0, 12)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {HTMLElement} list
 * @param {boolean | null} ok
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
function line(list, ok, key, params) {
  const li = document.createElement('li');
  li.className = `receipt-line ${ok === null ? 'receipt-line-na' : ok ? 'receipt-line-ok' : 'receipt-line-fail'}`;
  const icon = document.createElement('i');
  icon.dataset.lucide = ok === null ? 'info' : ok ? 'check-circle-2' : 'alert-circle';
  icon.className = 'w-3.5 h-3.5 flex-shrink-0 mt-0.5';
  const text = document.createElement('span');
  setText(text, key, params);
  li.append(icon, text);
  list.append(li);
}

/**
 * @param {VerifyReport} report
 */
function renderReport(report) {
  const out = byId('receiptVerifyResult');
  if (!out) return;
  const summary = document.createElement('p');
  summary.className = 'font-semibold text-slate-900';
  setText(summary, 'receipt.summary', { ok: report.summary.reproduced, total: report.summary.verifiable });
  const list = document.createElement('ul');
  list.className = 'space-y-1.5';
  line(list, report.idMatches, report.idMatches ? 'receipt.id_ok' : 'receipt.id_changed');
  line(list, report.answerMatches, report.answerMatches ? 'receipt.answer_ok' : 'receipt.answer_changed');
  for (const c of report.citations) {
    if (c.source === 'knowledge') {
      line(list, null, 'receipt.check_knowledge', { label: c.label });
      continue;
    }
    if (c.file !== 'match') {
      line(list, false, `receipt.check_file_${c.file}`, { label: c.label });
      continue;
    }
    const ok = c.passage === 'match';
    line(list, ok, `receipt.check_passage_${c.passage ?? 'mismatch'}`, { label: c.label, file: c.fileName ?? '' });
    if (c.text && c.text !== 'match') line(list, false, `receipt.check_text_${c.text}`, { label: c.label });
    if (c.chunk && c.chunk !== 'match') line(list, null, `receipt.check_chunk_${c.chunk}`, { label: c.label });
  }
  if (report.grounding) {
    const g = report.grounding;
    line(list, g.differences.length === 0, g.differences.length ? 'receipt.grounding_differs' : 'receipt.grounding_same', { n: g.recomputed, diff: g.differences.length });
    if (g.needsConversation) line(list, null, 'receipt.grounding_conversation');
  }
  for (const w of report.warnings) {
    const li = document.createElement('li');
    li.className = 'receipt-line receipt-line-na';
    li.textContent = w;
    list.append(li);
  }
  out.replaceChildren(summary, list);
  refreshIcons(out);
}

async function verify() {
  const out = byId('receiptVerifyResult');
  const receiptFile = /** @type {HTMLInputElement | null} */ (byId('receiptFile'))?.files?.[0];
  const sources = [.../** @type {HTMLInputElement | null} */ (byId('receiptSources'))?.files ?? []];
  const message = (/** @type {string} */ key, /** @type {Record<string, string | number>} */ params = {}) => {
    const p = document.createElement('p');
    setText(p, key, params);
    out?.replaceChildren(p);
  };
  if (!receiptFile) return message('receipt.verify_need_receipt');
  if (receiptFile.size > RECEIPT_LIMITS.bytes) return message('receipt.verify_invalid', { reason: 'size' });
  let parsed;
  try {
    parsed = JSON.parse(await receiptFile.text());
  } catch {
    return message('receipt.verify_invalid', { reason: 'JSON' });
  }
  message('receipt.verify_running');
  try {
    const result = await verifyReceiptFiles(parsed, sources);
    if ('invalid' in result) return message('receipt.verify_invalid', { reason: `${result.invalid.error}${result.invalid.path ? ` (${result.invalid.path})` : ''}` });
    renderReport(result);
  } catch (err) {
    message('receipt.verify_invalid', { reason: err instanceof Error ? err.message : String(err) });
  }
  return undefined;
}

export function initReceipts() {
  onAction('open-receipt', (el) => {
    current = el.dataset.arg ?? null;
    if (!current || !drafts.has(current)) return;
    openReceiptDialog('export', el);
    void preview();
  });
  onAction('open-receipt-verify', (el) => {
    current = null;
    openReceiptDialog('verify', el);
  });
  onAction('close-receipt', () => closeDialog(byId('receiptModal')));
  onAction('download-receipt', () => download());
  onAction('verify-receipt', () => verify());
  for (const id of ['receiptIncludeQuestion', 'receiptIncludeExcerpts']) byId(id)?.addEventListener('change', () => void preview());
}
