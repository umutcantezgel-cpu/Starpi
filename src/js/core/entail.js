// @ts-check
// Second opinion for the source check: a weak statement can be checked once more by a model that
// reads it next to its cited excerpt, either an entailment (NLI) model on this device
// (wasm/nli.js) or the AI layer's `entail_check` purpose on the judge role. The answer is
// entailed, neutral or contradicted.
//
// A second opinion is advisory. It runs only on weak statements, never on supported or unsupported
// ones; it never upgrades a verdict (an "entailed" leaves a weak statement weak) and is never the
// sentence gate. A "contradicted" keeps the statement amber and adds the reason
// `second_opinion_contradiction`, shown next to the deterministic reasons. A receipt records each
// opinion in its `secondOpinion` list as given; a verifier shows it and does not recompute it.
//
// This module holds the rules: which statements qualify, which part of the excerpts goes to the
// model, how the model's answer maps to a result, and how a result affects what is shown. The
// engines are passed in. Pure: no DOM, runs in the browser, in workers and in Node.
import { contentTokens, indexSource, tokenMatches } from './facts.js';
import { safeSlice, sentenceSpans } from './sentences.js';

/** @typedef {import('./grounding.js').GroundingReport} GroundingReport */
/** @typedef {import('./grounding.js').GroundingSource} GroundingSource */
/** @typedef {import('./grounding.js').SentenceResult} SentenceResult */
/** @typedef {import('./grounding.js').SecondOpinion} SecondOpinion */
/** @typedef {import('./grounding.js').Verdict} Verdict */
/** @typedef {'entailed' | 'neutral' | 'contradicted'} OpinionResult */
/** @typedef {'entailment' | 'neutral' | 'contradiction'} NliLabel */

/** The reason a contradicting second opinion adds to its statement (advisory, not a rule of the check). */
export const SECOND_OPINION_REASON = 'second_opinion_contradiction';

export const ENTAIL = Object.freeze({
  /** NLI: the probability a label needs to decide (otherwise neutral) */
  minScore: 0.6,
  /** judge: the confidence a "supported" or "contradicted" needs (otherwise neutral) */
  minConfidence: 0.6,
  /** statements per run */
  maxStatements: 12,
  /** characters of excerpt text given to the model with a statement */
  premiseChars: 1200,
  /** sentences taken from the cited excerpts */
  premisePassages: 3,
});

/** How far a verdict is from "supported": a second opinion may only keep or raise this. */
const SEVERITY = Object.freeze({ supported: 0, unchecked: 1, neutral: 1, weak: 2, unsupported: 3 });

/**
 * The excerpts a statement can be checked against: cited, delivered and not empty.
 * @param {SentenceResult} s
 * @param {GroundingSource[]} sources
 */
export function opinionCites(s, sources) {
  return s.cites.filter((i) => sources[i] && sources[i].delivered !== 'omitted' && sources[i].text.trim());
}

/**
 * Whether a statement may get a second opinion: weak (never supported, unsupported or unchecked),
 * with at least one delivered excerpt it cites.
 * @param {SentenceResult} s
 * @param {GroundingSource[]} sources
 */
export function eligible(s, sources) {
  return s.verdict === 'weak' && opinionCites(s, sources).length > 0;
}

/**
 * The part of the cited excerpts a model reads with a statement: the sentences that share most of
 * its words (up to ENTAIL.premisePassages), in excerpt order, within ENTAIL.premiseChars.
 * @param {string} statement
 * @param {GroundingSource[]} sources
 * @param {number[]} cites
 */
export function premiseFor(statement, sources, cites) {
  const words = [...new Set(contentTokens(statement))];
  /** @type {Array<{ text: string, score: number, order: number }>} */
  const sentences = [];
  for (const i of cites) {
    const text = sources[i]?.text ?? '';
    for (const span of sentenceSpans(text)) {
      const sentence = text.slice(span.start, span.end).replace(/^#+\s+/u, '').trim();
      if (!sentence) continue;
      const index = indexSource(sentence);
      sentences.push({ text: sentence, score: words.filter((w) => tokenMatches(w, index)).length, order: sentences.length });
    }
  }
  const chosen = sentences
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, ENTAIL.premisePassages)
    .sort((a, b) => a.order - b.order);
  const premise = (chosen.length ? chosen : sentences.slice(0, ENTAIL.premisePassages)).map((s) => s.text).join(' ');
  return premise.length > ENTAIL.premiseChars ? safeSlice(premise, ENTAIL.premiseChars).trimEnd() : premise;
}

/**
 * The result of an NLI model's label probabilities: the label with the highest probability when it
 * reaches ENTAIL.minScore, else neutral.
 * @param {Partial<Record<NliLabel, number>>} scores
 * @returns {OpinionResult}
 */
export function nliResult(scores) {
  const e = scores.entailment ?? 0;
  const c = scores.contradiction ?? 0;
  const n = scores.neutral ?? 0;
  if (c >= ENTAIL.minScore && c > e && c > n) return 'contradicted';
  if (e >= ENTAIL.minScore && e > c && e > n) return 'entailed';
  return 'neutral';
}

/**
 * The result of an `entail_check` answer ({ verdict: supported | contradicted | unknown,
 * confidence }): a verdict below ENTAIL.minConfidence counts as neutral.
 * @param {unknown} value
 * @returns {OpinionResult | null}  null for an answer that is not one
 */
export function judgeResult(value) {
  const v = /** @type {{ verdict?: unknown, confidence?: unknown }} */ (value && typeof value === 'object' ? value : {});
  const confidence = typeof v.confidence === 'number' ? v.confidence : 0;
  if (v.verdict === 'contradicted') return confidence >= ENTAIL.minConfidence ? 'contradicted' : 'neutral';
  if (v.verdict === 'supported') return confidence >= ENTAIL.minConfidence ? 'entailed' : 'neutral';
  if (v.verdict === 'unknown') return 'neutral';
  return null;
}

/**
 * The verdict to show for a statement with a second opinion: the verdict of the check, except that
 * a contradiction turns a statement amber (weak) that is not already weak or unsupported. A second
 * opinion never makes a verdict better.
 * @param {Verdict} verdict
 * @param {OpinionResult} result
 * @returns {Verdict}
 */
export function shownVerdict(verdict, result) {
  if (result !== 'contradicted') return verdict;
  return SEVERITY[verdict] >= SEVERITY.weak ? verdict : 'weak';
}

/**
 * The advisory reason a second opinion adds to its statement, or null (only a contradiction adds one).
 * @param {SecondOpinion} opinion
 * @returns {{ code: typeof SECOND_OPINION_REASON, level: 'weak', cites: number[], engine: SecondOpinion['engine'] } | null}
 */
export function opinionReason(opinion) {
  return opinion.result === 'contradicted' ? { code: SECOND_OPINION_REASON, level: 'weak', cites: opinion.cites.slice(), engine: opinion.engine } : null;
}

/**
 * An engine for second opinions: classifies statement/premise pairs, one result per pair (null when
 * it could not decide that pair).
 * @typedef {object} OpinionEngine
 * @property {'nli' | 'judge'} id
 * @property {string} model  the model as a receipt records it (at most 100 characters)
 * @property {(pairs: Array<{ premise: string, hypothesis: string }>, onProgress?: (done: number, total: number) => void) => Promise<Array<OpinionResult | null>>} classify
 */

/**
 * Second opinions for the weak statements of a report (at most ENTAIL.maxStatements), in statement
 * order. The report is not changed.
 * @param {GroundingReport} report
 * @param {GroundingSource[]} sources
 * @param {OpinionEngine} engine
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<SecondOpinion[]>}
 */
export async function secondOpinions(report, sources, engine, options = {}) {
  const targets = report.sentences
    .map((s, sentence) => ({ s, sentence }))
    .filter(({ s }) => eligible(s, sources))
    .slice(0, ENTAIL.maxStatements)
    .map(({ s, sentence }) => {
      const cites = opinionCites(s, sources);
      return { sentence, cites, pair: { premise: premiseFor(s.text, sources, cites), hypothesis: s.text } };
    });
  if (!targets.length) return [];
  const results = await engine.classify(
    targets.map((t) => t.pair),
    options.onProgress,
  );
  /** @type {SecondOpinion[]} */
  const out = [];
  targets.forEach((t, k) => {
    const result = results[k];
    if (result === 'entailed' || result === 'neutral' || result === 'contradicted') out.push({ sentence: t.sentence, cites: t.cites, engine: engine.id, model: engine.model.slice(0, 100), result });
  });
  return out;
}
