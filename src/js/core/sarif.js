// @ts-check
// SARIF 2.1.0 (OASIS Static Analysis Results Interchange Format) for source-check results, so a
// check of generated text can fail a CI job and show up in code scanning next to the line it is
// about. One result per statement that is not supported: level "error" for unsupported, "warning"
// for weak; the rule is the reason that decided the verdict, and the message names every reason.
//
// Pure: WebCrypto (crypto.subtle) only, for the fingerprints.
import { sha256Hex } from './hash.js';
import { GROUNDING, reasonCodes } from './grounding.js';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/**
 * What each reason says, in English; the same wording as the app (src/locales/en.json,
 * grounding.reason_*), which a unit test keeps in step.
 * @type {Readonly<Record<import('./grounding.js').ReasonCode, string>>}
 */
export const REASON_MESSAGES = Object.freeze({
  missing_fact: '{fact} is not in {label}.',
  fact_elsewhere: '{fact} is in {other}, not in the cited {label}.',
  fact_context: '{fact} is in {label}, but next to something else: “{found}”.',
  name_missing: 'The name {fact} does not appear in {label}.',
  uncited_found: 'No citation; the matching passage is {other}.',
  uncited_missing: 'No citation, and {fact} is in none of the excerpts.',
  low_overlap: 'Few of its words appear in {label}.',
  unknown_citation: '{found} is not one of the excerpts this answer was given.',
  label_mismatch: '{found} is written differently from {label}.',
  quote_missing: 'The quotation {fact} is not in {label}.',
  approximate: '{fact} is rounded or approximate; {label} says {found}.',
  from_conversation: '{fact} comes from the question or the conversation, not from an excerpt.',
  not_delivered: "{label} did not fit into the model's context.",
  negation_inversion: '{label} says the opposite: “{found}”.',
  name_context: '{label} names someone or something else here, not {fact}: “{found}”.',
  relation_inverted: '“{fact}” is the wrong way round: {label} says “{found}”.',
  relation_unsupported: '{label} does not support “{fact}”: “{found}”.',
});

/**
 * Rule descriptions for code scanning: a short title, what the rule finds, and the usual level.
 * @type {Readonly<Record<string, { name: string, short: string, full: string, level: 'error' | 'warning' }>>}
 */
const RULES = Object.freeze({
  missing_fact: { name: 'MissingFact', short: 'Value not in the cited excerpt', full: 'A number, date, time, weekday, month or code in the statement is not in the excerpts it cites, nor in any other excerpt.', level: 'error' },
  fact_elsewhere: { name: 'FactElsewhere', short: 'Value from another excerpt', full: 'A value of the statement is not in the excerpts it cites but in another one: the statement cites the wrong source.', level: 'warning' },
  fact_context: { name: 'FactContext', short: 'Value next to something else', full: 'The cited excerpt contains the value, but only next to words the statement does not use, while the words the statement puts next to it stand with another value.', level: 'warning' },
  name_missing: { name: 'NameMissing', short: 'Name not in the cited excerpt', full: 'A capitalised name in an English statement does not appear in the excerpts it cites.', level: 'warning' },
  uncited_found: { name: 'UncitedFound', short: 'No citation', full: 'The statement cites nothing; a value it states is in an excerpt it could have cited.', level: 'warning' },
  uncited_missing: { name: 'UncitedMissing', short: 'No citation, value in no excerpt', full: 'The statement cites nothing, and a value it states is in none of the excerpts.', level: 'error' },
  low_overlap: { name: 'LowOverlap', short: 'Little wording in common', full: 'Fewer than half of the content words of the statement appear in the excerpts it cites.', level: 'warning' },
  unknown_citation: { name: 'UnknownCitation', short: 'Unknown citation', full: 'The statement cites a label that is not one of the excerpts.', level: 'error' },
  label_mismatch: { name: 'LabelMismatch', short: 'Citation label written differently', full: 'A citation label is written differently from the excerpt it most likely means; the check used that excerpt.', level: 'warning' },
  quote_missing: { name: 'QuoteMissing', short: 'Quotation not in the cited excerpt', full: 'A quotation in the statement does not appear in the excerpts it cites (weak when part of it does).', level: 'error' },
  approximate: { name: 'Approximate', short: 'Rounded or approximate value', full: 'A value of the statement is close to a value in the cited excerpt (rounded or approximate) but not equal to it.', level: 'warning' },
  from_conversation: { name: 'FromConversation', short: 'From the question, not an excerpt', full: 'A value or name of the statement comes from the question or earlier turns, not from an excerpt.', level: 'warning' },
  not_delivered: { name: 'NotDelivered', short: 'Cited excerpt not delivered', full: 'The statement cites only excerpts that did not reach the model.', level: 'error' },
  negation_inversion: { name: 'NegationInversion', short: 'Says the opposite of the excerpt', full: 'A clause of the statement matches a clause of the cited excerpt in its words but not in its negation: one says "not", "never", "no", "without", "disabled" or "prohibited" (or the German counterparts) where the other does not. Always weak: a restatement of a negated rule can read the same.', level: 'warning' },
  name_context: { name: 'NameContext', short: 'Name next to something else', full: 'The statement matches a passage of the cited excerpt in its other words, but the passage has a different name (person, site, vendor or product) where the statement has its own, and the statement\u2019s name stands elsewhere or nowhere.', level: 'warning' },
  relation_inverted: { name: 'RelationInverted', short: 'Relation the wrong way round', full: 'A change, comparison, order in time or value carried over from the statement before goes the other way in the cited excerpts: "rose" where the values fell, "more than" where the other value is larger, "before" where the other event came first. Always weak: the values are bound to their sides by their words.', level: 'warning' },
  relation_unsupported: { name: 'RelationUnsupported', short: 'Relation not given by the excerpt', full: 'The cited excerpts give the direction of a relation but not the stated factor or share ("doubled" where the value rose by half, "15 % of" where the values give 20 %), or two equal values for a comparison.', level: 'warning' },
  too_long: { name: 'TooLong', short: 'Part too long to check', full: 'A part of the document is longer than the source check accepts (20,000 characters or 300 statements) even after splitting at headings and paragraphs, so it was not checked.', level: 'error' },
});

/**
 * Labels of excerpts, for messages: up to three, then how many more.
 * @param {number[] | undefined} indexes
 * @param {Array<{ label: string }>} sources
 */
function labelsOf(indexes, sources) {
  const labels = (indexes ?? []).map((i) => sources[i]?.label).filter(Boolean);
  if (!labels.length) return 'the cited excerpts';
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more excerpts` : labels.join(', ');
}

/**
 * One reason as an English sentence.
 * @param {import('./grounding.js').Reason} reason
 * @param {Array<{ label: string }>} sources
 */
export function describeReason(reason, sources) {
  const template = REASON_MESSAGES[reason.code] ?? reason.code;
  const values = /** @type {Record<string, string>} */ ({ fact: reason.fact ?? '', found: reason.found ?? '', label: labelsOf(reason.cites, sources), other: labelsOf(reason.other, sources) });
  return template.replace(/\{(fact|found|label|other)\}/g, (_, key) => values[key]);
}

/**
 * The reason that decided a statement's verdict: the first unsupported one, else the first.
 * @param {import('./grounding.js').SentenceResult} statement
 */
export function decidingReason(statement) {
  return statement.reasons.find((r) => r.level === 'unsupported') ?? statement.reasons[0] ?? null;
}

/**
 * @param {string} text
 * @param {number} max
 */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A SARIF log for the checked documents.
 * @param {Array<{ uri: string, report: import('./document.js').DocumentReport, sources: Array<{ label: string }> }>} documents
 * @param {{ name: string, version: string, informationUri: string }} tool
 */
export async function toSarif(documents, tool) {
  // The rules of the version of the source check that made the reports (version 2 reports keep
  // their rule list).
  const version = documents.reduce((v, d) => Math.max(v, d.report.algorithm.version || 0), 0) || GROUNDING.version;
  const ruleIds = [...reasonCodes(version), 'too_long'];
  const rules = ruleIds.map((id) => {
    const rule = RULES[id];
    return {
      id,
      name: rule.name,
      shortDescription: { text: rule.short },
      fullDescription: { text: rule.full },
      help: { text: `${rule.full} The source check compares each statement with the excerpts it cites; a finding means: open the source and check. It does not prove the statement wrong.` },
      defaultConfiguration: { level: rule.level },
      properties: { tags: ['grounding', 'documentation'] },
    };
  });
  const results = [];
  for (const { uri, report, sources } of documents) {
    for (const s of report.statements) {
      if (s.verdict !== 'unsupported' && s.verdict !== 'weak') continue;
      const reason = decidingReason(s);
      const ruleId = reason?.code ?? 'uncited_found';
      const said = s.reasons.map((r) => describeReason(r, sources)).join(' ');
      results.push({
        ruleId,
        ruleIndex: ruleIds.indexOf(ruleId),
        level: s.verdict === 'unsupported' ? 'error' : 'warning',
        message: { text: `${s.verdict === 'unsupported' ? 'Not supported by the cited sources' : 'Check against the sources'}: “${clip(s.text, 200)}” ${said}`.trim() },
        locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: s.line, startColumn: s.column } } }],
        partialFingerprints: { 'starpiStatement/v1': await sha256Hex(`${ruleId}\n${s.text}`) },
      });
    }
    for (const part of report.skipped) {
      results.push({
        ruleId: 'too_long',
        ruleIndex: ruleIds.indexOf('too_long'),
        level: 'error',
        message: { text: `Lines ${part.line} to ${part.endLine} were not checked: the part is longer than the source check accepts.` },
        locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: part.line, endLine: part.endLine } } }],
        partialFingerprints: { 'starpiStatement/v1': await sha256Hex(`too_long\n${uri}\n${part.line}`) },
      });
    }
  }
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: { driver: { name: tool.name, version: tool.version, semanticVersion: tool.version, informationUri: tool.informationUri, rules } },
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
}
