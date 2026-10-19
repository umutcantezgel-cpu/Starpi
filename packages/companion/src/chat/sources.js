// @ts-check
// The sources of an answer in source mode: passages of documents (search index), notes (the
// memory's recall, which also counts the recall for the ranking) and the latest feed readings that
// match the question. Each becomes a labelled source ([S1], [S2], ...) for the prompt and for the
// sentence gate, which withholds every number that the source a sentence cites does not hold. A
// feed reading is a source like any other: its number can be cited exactly as the feed reported it.
// Nothing above the class ceiling is taken (secret content never reaches a prompt).
import { codeOf } from '../lib/errors.js';

/**
 * @typedef {object} AnswerSource
 * @property {string} label          "[S1]"
 * @property {'doc' | 'note' | 'tool'} kind
 * @property {string} title
 * @property {string} [detail]
 * @property {string} text
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {{ type: 'document' | 'note', id: string, chunk: number } | { type: 'reading', sourceId: string, series: string, at: string } | { type: 'tool', tool: string }} ref
 */

/**
 * A reading as one line of text.
 * @param {{ source_id: string, series: string, value: number, unit: string, ts_source: string, quality: string }} r
 */
export const readingText = (r) => `${r.series} from ${r.source_id}: ${r.value}${r.unit ? ` ${r.unit}` : ''}, measured at ${r.ts_source}, quality ${r.quality}.`;

/**
 * @param {import('../setup/hub.js').Hub} hub
 * @param {string} question
 * @param {object} options
 * @param {import('../contracts/data-classes.js').DataClass} options.maxClass
 * @param {readonly string[] | null} [options.documents]  only these documents (ids); null: all
 * @param {boolean} [options.notes]
 * @param {boolean} [options.feeds]
 * @param {number} [options.passages]
 * @param {AbortSignal} [options.signal]
 * @param {import('../lib/log.js').Logger} [options.log]
 * @returns {Promise<AnswerSource[]>}
 */
export async function gatherSources(hub, question, { maxClass, documents = null, notes = true, feeds = true, passages = 5, signal, log = () => {} }) {
  /** @type {Omit<AnswerSource, 'label'>[]} */
  const found = [];
  const index = hub.get('retrieval');
  if (index && (documents === null || documents.length > 0)) {
    const { passages: hits } = await index.search(question, { k: passages, collections: ['documents'], maxClass, ids: documents ? new Set(documents) : undefined, signal });
    for (const p of hits) found.push({ kind: 'doc', title: p.title, detail: `passage ${p.chunk + 1}`, text: p.text, dataClass: p.dataClass, ref: { type: 'document', id: p.id, chunk: p.chunk } });
  }
  const memory = hub.get('memory');
  if (memory && notes) {
    try {
      for (const n of await memory.recall(question, { k: 3, maxClass, signal })) found.push({ kind: 'note', title: n.title, text: n.text, dataClass: n.dataClass, ref: { type: 'note', id: n.id, chunk: n.chunk } });
    } catch (err) {
      log('warn', 'notes_unavailable', { code: codeOf(err) });
    }
  }
  const feed = hub.get('feeds');
  if (feed && feeds) {
    for (const r of feed.relevant(question, { max: 6, maxClass })) {
      found.push({ kind: 'tool', title: `${r.source_id} ${r.series}`, text: readingText(r), dataClass: r.dataClass, ref: { type: 'reading', sourceId: r.source_id, series: r.series, at: r.ts_source } });
    }
  }
  return found.map((s, i) => ({ ...s, label: `[S${i + 1}]` }));
}
