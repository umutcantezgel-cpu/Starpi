// @ts-check
// The text a research job sends to a web search. The question goes out as the person typed it,
// with white space tidied and the length capped; nothing is rewritten or translated, so what is
// shown before the search is exactly what leaves the device. With the optional stripping on, parts
// that identify a person are taken out first: e-mail addresses, phone numbers, IBANs, card numbers
// and IP addresses. The result names the kinds that were removed, never the removed text. Pure.
import { QUESTION_CHARS } from './prompts.js';

/** @typedef {'email' | 'phone' | 'iban' | 'card' | 'ip'} PiiKind */
/** @typedef {{ text: string, removed: PiiKind[] }} WebQuery */

/** Every kind the stripping knows, in the order it runs. */
export const PII_KINDS = /** @type {readonly PiiKind[]} */ (Object.freeze(['email', 'iban', 'card', 'ip', 'phone']));

const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+(?![\w-])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const IP = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
const PHONE = /(?<![\w+])(?:\+|00)?\(?\d[\d \-/().]{5,22}\d(?![\w])/g;
const DATE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Whether a run of digits passes the Luhn check that card numbers carry.
 * @param {string} digits
 */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Whether a candidate looks like a phone number rather than a year, an amount or a date: it starts
 * like one (+, 00 or a leading 0, or a bracketed area code) and has 7 to 15 digits.
 * @param {string} match
 */
function isPhone(match) {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || DATE.test(match.trim())) return false;
  return /^(?:\+|00|0|\(0?\d)/.test(match);
}

/**
 * The question as a web search gets it.
 * @param {string} question
 * @param {{ stripPii?: boolean }} [options]
 * @returns {WebQuery}
 */
export function webQuery(question, options = {}) {
  let text = String(question ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /** @type {Set<PiiKind>} */
  const removed = new Set();
  if (options.stripPii) {
    /** @param {PiiKind} kind @param {RegExp} pattern @param {(m: string) => boolean} [accept] */
    const strip = (kind, pattern, accept = () => true) => {
      text = text.replace(pattern, (m) => {
        if (!accept(m)) return m;
        removed.add(kind);
        return ' ';
      });
    };
    strip('email', EMAIL);
    strip('iban', IBAN);
    strip('card', CARD, (m) => luhn(m.replace(/\D/g, '')));
    strip('ip', IP);
    strip('phone', PHONE, isPhone);
    text = text
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (text.length > QUESTION_CHARS) text = text.slice(0, QUESTION_CHARS).trimEnd();
  return { text, removed: PII_KINDS.filter((k) => removed.has(k)) };
}
