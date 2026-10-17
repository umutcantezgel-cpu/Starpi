// @ts-check
// Answer receipts in the app: every answer with citations keeps a receipt draft in memory (never
// stored), and the receipt dialog downloads it as JSON or verifies a receipt against original
// files. Everything shown here is set with textContent; receipts and files are read on this device.
// With "Sign exported receipts" on (Settings › Trust), a download names this device's key as its
// signer and is signed with it; the signer (trust/signing.js) loads only when the dialog needs it.
import { buildReceipt, RECEIPT_LIMITS } from '../core/receipt.js';
import { closeDialog, openDialog } from '../dialog.js';
import { byId, downloadText, onAction, setHidden } from '../dom.js';
import { refreshIcons } from '../icons.js';
import { formatNumber, setText } from '../i18n/index.js';
import { verifyReceiptFiles } from './workspace.js';

/** @typedef {import('../core/receipt.js').ReceiptDraft} ReceiptDraft */
/** @typedef {import('../core/receipt.js').VerifyReport} VerifyReport */
/** @typedef {import('../trust/signing.js').ExportSigner} ExportSigner */

const MAX_DRAFTS = 50;
const MAX_KEY_BYTES = 16_384;
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

/**
 * The signer of a download: this device's key when "Sign exported receipts" is on, else null and why.
 * @returns {Promise<{ exporter: ExportSigner | null, reason: 'off' | 'unavailable' | null }>}
 */
async function signingForExport() {
  try {
    const { receiptSigner } = await import('../trust/signing.js');
    const exporter = await receiptSigner.exportSigner();
    if (exporter) return { exporter, reason: null };
    return { exporter: null, reason: receiptSigner.state().enabled ? 'unavailable' : 'off' };
  } catch (err) {
    console.warn('[starpi] receipts are exported unsigned', err);
    return { exporter: null, reason: 'unavailable' };
  }
}

/**
 * The line under the receipt id that says whether and with which key a download is signed.
 * @param {ExportSigner | null} exporter
 * @param {'off' | 'unavailable' | null} reason
 */
function showSigning(exporter, reason) {
  const section = byId('receiptExport');
  if (!section) return;
  let el = byId('receiptSigning');
  if (!el) {
    el = document.createElement('p');
    el.id = 'receiptSigning';
    el.className = 'text-xs text-slate-700';
    el.setAttribute('role', 'status');
    section.querySelector('dl')?.after(el);
  }
  if (exporter) setText(el, 'trust.receipt.signed_by', { key: `${exporter.signer.keyId.slice(0, 16)}…`, alg: exporter.signer.alg });
  else setText(el, reason === 'off' ? 'trust.receipt.unsigned_off' : 'trust.receipt.unsigned_unavailable');
}

/** Shows the id and contents of the receipt the current options produce. */
async function preview() {
  const draft = current ? drafts.get(current) : undefined;
  if (!draft) return;
  const run = ++buildSeq;
  const { exporter, reason } = await signingForExport();
  const receipt = await buildReceipt(draft, { ...options(), signer: exporter?.signer });
  if (run !== buildSeq) return;
  showSigning(exporter, reason);
  const idEl = byId('receiptId');
  if (idEl) idEl.textContent = receipt.id.slice(0, 16);
  const rootEl = byId('receiptRoot');
  if (rootEl) rootEl.textContent = receipt.merkle ? receipt.merkle.root.slice(0, 16) : '–';
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
  const { exporter, reason } = await signingForExport();
  showSigning(exporter, reason);
  const built = await buildReceipt(draft, { ...options(), signer: exporter?.signer });
  const receipt = exporter ? await exporter.sign(built) : built;
  downloadText(`starpi-receipt-${receipt.id.slice(0, 12)}.json`, `${JSON.stringify(receipt, null, 2)}\n`, 'application/json');
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
 * @param {boolean} keyChosen  a public key was chosen to check who signed
 * @param {boolean} ownKey  the signing key is one of this device's keys
 */
function renderReport(report, keyChosen, ownKey) {
  const out = byId('receiptVerifyResult');
  if (!out) return;
  const summary = document.createElement('p');
  summary.className = 'font-semibold text-slate-900';
  setText(summary, 'receipt.summary', { ok: report.summary.reproduced, total: report.summary.verifiable });
  const list = document.createElement('ul');
  list.className = 'space-y-1.5';
  line(list, report.idMatches, report.idMatches ? 'receipt.id_ok' : 'receipt.id_changed');
  line(list, report.answerMatches, report.answerMatches ? 'receipt.answer_ok' : 'receipt.answer_changed');
  if (report.merkle) {
    const m = report.merkle;
    const ok = m.rootMatches && m.validProofs === report.citations.length;
    line(list, ok, ok ? 'receipt.merkle_ok' : 'receipt.merkle_failed', { n: report.citations.length, valid: m.validProofs });
  } else line(list, null, 'receipt.format_v1');
  if (report.signer) line(list, null, 'trust.receipt.signer', { key: `${report.signer.keyId.slice(0, 16)}…`, alg: report.signer.alg });
  if (report.signature) {
    const sig = report.signature;
    const params = { alg: sig.alg ?? '?', key: sig.keyId ? `${sig.keyId.slice(0, 16)}…` : '' };
    if (sig.status === 'unsigned') line(list, keyChosen ? false : null, keyChosen ? 'receipt.signature_unsigned_key' : 'receipt.signature_unsigned');
    else if (sig.status === 'missing') line(list, false, 'trust.receipt.signature_missing', params);
    else if (sig.status === 'valid') {
      line(list, true, sig.trusted ? 'receipt.signature_trusted' : 'receipt.signature_embedded', params);
      // Trust comes only from a public key the user chose, never from the key inside the receipt.
      line(list, sig.trusted ? true : null, sig.trusted ? 'trust.receipt.trusted' : 'trust.receipt.not_trusted');
      if (ownKey) line(list, null, 'trust.receipt.own_key');
    }
    else if (sig.status === 'key_mismatch') line(list, false, 'receipt.signature_key_mismatch', params);
    else if (sig.status === 'unsupported_algorithm') line(list, null, 'receipt.signature_unsupported', params);
    else line(list, false, 'receipt.signature_invalid', params);
  }
  for (const c of report.citations) {
    if (c.source === 'knowledge') {
      line(list, null, 'receipt.check_knowledge', { label: c.label });
      continue;
    }
    if (c.file !== 'match') {
      line(list, false, `receipt.check_file_${c.file}`, { label: c.label });
      continue;
    }
    if (c.text === 'ocr') {
      line(list, null, 'trust.receipt.check_ocr', { label: c.label });
      continue;
    }
    const ok = c.passage === 'match';
    line(list, ok, `receipt.check_passage_${c.passage ?? 'mismatch'}`, { label: c.label, file: c.fileName ?? '' });
    if (c.text && c.text !== 'match') line(list, false, `receipt.check_text_${c.text}`, { label: c.label });
    if (c.chunk && c.chunk !== 'match') line(list, null, `receipt.check_chunk_${c.chunk}`, { label: c.label });
  }
  for (const c of report.citations) if (c.proof === false) line(list, false, 'receipt.check_proof_invalid', { label: c.label });
  if (report.grounding) {
    const g = report.grounding;
    line(list, g.differences.length === 0, g.differences.length ? 'receipt.grounding_differs' : 'receipt.grounding_same', { n: g.recomputed, diff: g.differences.length });
    if (g.needsConversation) line(list, null, 'receipt.grounding_conversation');
  }
  if (report.gate) line(list, null, 'trust.receipt.gate', { mode: report.gate.mode, released: report.gate.released, withheld: report.gate.withheld });
  const advisory = report.advisory;
  if (advisory?.secondOpinions) line(list, null, 'trust.receipt.second_opinions', { n: advisory.secondOpinions, contradicted: advisory.contradicted });
  if (advisory?.relations) line(list, null, 'trust.receipt.relations', { n: advisory.relations, flagged: advisory.flagged });
  for (const w of report.warnings) {
    const li = document.createElement('li');
    li.className = 'receipt-line receipt-line-na';
    li.textContent = w;
    list.append(li);
  }
  out.replaceChildren(summary, list);
  refreshIcons(out);
}

/**
 * Whether a key id is one of this device's signing keys.
 * @param {string} keyId
 */
async function ownsSigningKey(keyId) {
  try {
    const { receiptSigner } = await import('../trust/signing.js');
    return await receiptSigner.ownsKey(keyId);
  } catch {
    return false;
  }
}

async function verify() {
  const out = byId('receiptVerifyResult');
  const receiptFile = /** @type {HTMLInputElement | null} */ (byId('receiptFile'))?.files?.[0];
  const sources = [.../** @type {HTMLInputElement | null} */ (byId('receiptSources'))?.files ?? []];
  const keyFile = /** @type {HTMLInputElement | null} */ (byId('receiptPublicKey'))?.files?.[0];
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
  // A public key in JWK or PEM form is a few hundred bytes; anything far larger is not one.
  if (keyFile && keyFile.size > MAX_KEY_BYTES) return message('receipt.verify_bad_key', { reason: 'size' });
  const publicKey = keyFile ? await keyFile.text() : null;
  message('receipt.verify_running');
  try {
    const result = await verifyReceiptFiles(parsed, sources, publicKey);
    if ('invalidKey' in result) return message('receipt.verify_bad_key', { reason: result.invalidKey });
    if ('invalid' in result) return message('receipt.verify_invalid', { reason: `${result.invalid.error}${result.invalid.path ? ` (${result.invalid.path})` : ''}` });
    const keyId = result.signature?.status === 'valid' ? result.signature.keyId : null;
    renderReport(result, publicKey !== null, keyId !== null && (await ownsSigningKey(keyId)));
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
