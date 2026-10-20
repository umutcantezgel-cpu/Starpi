// @ts-check
// One verification of an installation, for `starpi-companion verify-audit`, the owner's audit page
// and the start: the audit chain recomputed end to end, the event log's links, and the anchors in
// the anchor folder (signatures, links, and whether the database still reaches the newest one).
import { verifyEventLinks, eventsHead } from '../store/sqlite.js';
import { checkAnchors } from './anchors.js';
import { verifyChain } from './chain.js';

/**
 * @typedef {object} AuditReport
 * @property {boolean} ok
 * @property {{ seq: number, hash: string }} head
 * @property {number} records
 * @property {{ seq: number, link: string }} events
 * @property {{ pinned: string | null, count: number, newest: number | null }} anchors
 * @property {Array<{ kind: string, seq?: number, n?: number, reason?: string, detail?: string }>} findings
 */

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, anchorDir: string, keyId?: string }} options
 * @returns {AuditReport}
 */
export function verifyInstallation({ db, anchorDir, keyId }) {
  const chain = verifyChain(db);
  const eventFindings = verifyEventLinks(db);
  const anchors = checkAnchors({ db, anchorDir, keyId });
  const findings = [...chain.findings, ...eventFindings, ...anchors.findings];
  return {
    ok: findings.length === 0,
    head: chain.head,
    records: chain.records,
    events: eventsHead(db),
    anchors: { pinned: anchors.pinned?.keyId ?? null, count: anchors.anchors.length, newest: anchors.newest?.n ?? null },
    findings,
  };
}
