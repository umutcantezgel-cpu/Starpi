// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// JSON in model answers. Models wrap the JSON they were asked for in reasoning blocks (<think>…</think>,
// sometimes with only the closing tag left), Markdown code fences or a sentence of prose. extractJson()
// finds the first object or array that parses, whatever surrounds it. validateSchema() checks a value
// against the small part of JSON Schema the purposes use; the same schema object travels to the
// provider as the response format (decoderSchema() leaves out what constrained decoders choke on).
// errorsFor() turns a raw answer into the list of problems a retry names, retryHint() into the
// sentence that asks the model to fix them.

/**
 * @typedef {'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'} JsonType
 *
 * @typedef {object} JsonSchema
 * @property {JsonType} [type]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {string[]} [required]
 * @property {boolean} [additionalProperties]  only `false` is enforced
 * @property {JsonSchema} [items]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {number} [minLength]   counted on the trimmed text
 * @property {number} [maxLength]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {readonly (string | number | boolean | null)[]} [enum]
 * @property {string} [description]
 */

/** Reasoning tags local and open models write before the answer. */
export const REASONING_TAGS = Object.freeze(['think', 'thinking', 'thought', 'reasoning']);

const TAGS = REASONING_TAGS.join('|');
const PAIRED = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const OPENING = new RegExp(`<(?:${TAGS})\\b[^>]*>`, 'i');
const CLOSING = new RegExp(`<\\/(?:${TAGS})\\s*>`, 'gi');
const FENCE = /```[\w-]*[ \t]*\r?\n?([\s\S]*?)```/g;

/** Longest answer scanned; a runaway answer cannot stall the scanner. */
export const MAX_SCAN_CHARS = 200_000;
/** Most problems one validation reports. */
export const MAX_ERRORS = 20;

/**
 * The answer without reasoning: paired blocks go, everything up to a lone closing tag goes (the
 * opening tag belonged to the chat template), and an opening tag that never closes cuts the rest
 * (the answer stopped while the model was still reasoning).
 * @param {string} text
 * @returns {string}
 */
export function stripReasoning(text) {
  let out = String(text ?? '').replace(PAIRED, '');
  let lastClose = -1;
  for (const m of out.matchAll(CLOSING)) lastClose = (m.index ?? 0) + m[0].length;
  if (lastClose >= 0) out = out.slice(lastClose);
  const open = OPENING.exec(out);
  if (open) out = out.slice(0, open.index);
  return out.trim();
}

/**
 * @param {string} text
 * @returns {object | undefined} an object or array, else undefined
 */
function parseStructure(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Index just past the bracket that closes the one at `start`, skipping brackets inside JSON
 * strings; -1 when the structure never closes or closes with the wrong bracket.
 * @param {string} text
 * @param {number} start
 */
function closingIndex(text, start) {
  /** @type {string[]} */
  const expected = [];
  let quoted = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') expected.push('}');
    else if (ch === '[') expected.push(']');
    else if (ch === '}' || ch === ']') {
      if (expected.pop() !== ch) return -1;
      if (expected.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first balanced object or array in free text that parses.
 * @param {string} text
 * @returns {object | undefined}
 */
function firstStructure(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const end = closingIndex(text, i);
    if (end < 0) continue;
    const value = parseStructure(text.slice(i, end));
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The JSON object or array of a model answer, or null. Reasoning goes first; then the whole rest,
 * each fenced block and finally the first balanced structure in the prose are tried. A bare string
 * or number is no JSON answer.
 * @param {unknown} text
 * @returns {object | null}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const clean = stripReasoning(text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text);
  if (!clean) return null;
  const whole = parseStructure(clean);
  if (whole !== undefined) return whole;
  for (const m of clean.matchAll(FENCE)) {
    const inner = m[1].trim();
    const fenced = parseStructure(inner) ?? firstStructure(inner);
    if (fenced !== undefined) return fenced;
  }
  return firstStructure(clean) ?? null;
}

/** Keywords some constrained decoders turn into grammars they cannot build; validation keeps them. */
const DECODER_SKIP = new Set(['minLength', 'maxLength', 'uniqueItems', 'description']);

/**
 * A copy of a schema for the provider's response format: string lengths, uniqueness and
 * descriptions are left out. The full schema still validates the answer.
 * @param {JsonSchema} schema
 * @returns {JsonSchema}
 */
export function decoderSchema(schema) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DECODER_SKIP.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decoderSchema(/** @type {JsonSchema} */ (v))]));
    } else if (key === 'items' && value && typeof value === 'object') {
      out.items = decoderSchema(/** @type {JsonSchema} */ (value));
    } else out[key] = Array.isArray(value) ? [...value] : value;
  }
  return /** @type {JsonSchema} */ (out);
}

/**
 * @param {unknown} value
 * @returns {JsonType}
 */
function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return /** @type {JsonType} */ (typeof value);
}

/**
 * Problems of a value against the schema subset above, as codes `schema:<path>:<rule>`
 * (`schema:$.items[2]:enum`, `schema:$:required:title`). A value of the wrong type is not looked
 * into further. At most MAX_ERRORS are reported.
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateSchema(value, schema, path = '$') {
  /** @type {string[]} */
  const errors = [];
  check(value, schema, path, errors);
  return errors.slice(0, MAX_ERRORS);
}

/**
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} path
 * @param {string[]} errors
 */
function check(value, schema, path, errors) {
  if (errors.length >= MAX_ERRORS) return;
  const actual = jsonType(value);
  if (schema.type && schema.type !== actual && !(schema.type === 'number' && actual === 'integer')) {
    errors.push(`schema:${path}:type`);
    return;
  }
  if (schema.enum && !schema.enum.includes(/** @type {string | number | boolean | null} */ (value))) errors.push(`schema:${path}:enum`);
  if (actual === 'string') {
    const s = /** @type {string} */ (value);
    if (schema.minLength !== undefined && s.trim().length < schema.minLength) errors.push(`schema:${path}:minLength`);
    if (schema.maxLength !== undefined && s.length > schema.maxLength) errors.push(`schema:${path}:maxLength`);
  } else if (actual === 'number' || actual === 'integer') {
    const n = /** @type {number} */ (value);
    if (!Number.isFinite(n)) errors.push(`schema:${path}:finite`);
    if (schema.minimum !== undefined && n < schema.minimum) errors.push(`schema:${path}:minimum`);
    if (schema.maximum !== undefined && n > schema.maximum) errors.push(`schema:${path}:maximum`);
  } else if (actual === 'array') {
    const list = /** @type {unknown[]} */ (value);
    if (schema.minItems !== undefined && list.length < schema.minItems) errors.push(`schema:${path}:minItems`);
    if (schema.maxItems !== undefined && list.length > schema.maxItems) errors.push(`schema:${path}:maxItems`);
    if (schema.uniqueItems && new Set(list.map((v) => JSON.stringify(v))).size !== list.length) errors.push(`schema:${path}:uniqueItems`);
    const items = schema.items;
    if (items) list.forEach((item, i) => check(item, items, `${path}[${i}]`, errors));
  } else if (actual === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) errors.push(`schema:${path}:required:${key}`);
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(record)) {
      if (Object.hasOwn(props, key)) check(v, props[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`schema:${path}:additional:${key.slice(0, 40)}`);
    }
  }
}

/**
 * Reads a raw answer against a schema: the value when it is there and fits, else the problems
 * (`no_json` when the answer holds no object or array at all).
 * @param {unknown} raw
 * @param {JsonSchema} schema
 * @returns {{ ok: true, value: object, errors: [] } | { ok: false, value?: object, errors: string[] }}
 */
export function readJsonAnswer(raw, schema) {
  const value = raw !== null && typeof raw === 'object' ? raw : extractJson(raw);
  if (value === null) return { ok: false, errors: ['no_json'] };
  const errors = validateSchema(value, schema);
  return errors.length ? { ok: false, value, errors } : { ok: true, value, errors: [] };
}

/**
 * The problems of a raw answer against a schema; empty when it fits.
 * @param {unknown} raw
 * @param {JsonSchema} schema
 * @returns {string[]}
 */
export function errorsFor(raw, schema) {
  return readJsonAnswer(raw, schema).errors;
}

/** What each validation rule asks the model to do, per language. */
const RULE_TEXT = /** @type {const} */ ({
  en: {
    type: 'has the wrong type',
    enum: 'is not one of the allowed values',
    minLength: 'is empty or too short',
    maxLength: 'is too long',
    minimum: 'is too small',
    maximum: 'is too large',
    finite: 'is not a finite number',
    minItems: 'has too few entries',
    maxItems: 'has too many entries',
    uniqueItems: 'repeats an entry',
    required: 'is missing',
    additional: 'is not allowed',
  },
  de: {
    type: 'hat den falschen Typ',
    enum: 'ist keiner der erlaubten Werte',
    minLength: 'ist leer oder zu kurz',
    maxLength: 'ist zu lang',
    minimum: 'ist zu klein',
    maximum: 'ist zu groß',
    finite: 'ist keine endliche Zahl',
    minItems: 'hat zu wenige Einträge',
    maxItems: 'hat zu viele Einträge',
    uniqueItems: 'wiederholt einen Eintrag',
    required: 'fehlt',
    additional: 'ist nicht erlaubt',
  },
});

/**
 * One problem code as a short phrase for the retry message.
 * @param {string} code
 * @param {'en' | 'de'} locale
 */
export function describeError(code, locale = 'en') {
  const lang = locale === 'de' ? 'de' : 'en';
  if (code === 'no_json') return lang === 'de' ? 'Die Antwort enthielt kein JSON-Objekt.' : 'The answer contained no JSON object.';
  if (code === 'truncated') return lang === 'de' ? 'Die Antwort brach vor dem Ende ab.' : 'The answer stopped before it was complete.';
  const m = /^schema:([^:]+):([A-Za-z]+)(?::(.+))?$/.exec(code);
  if (!m) return code.slice(0, 80);
  const [, path, rule, detail] = m;
  const where = rule === 'required' || rule === 'additional' ? `${path === '$' ? '' : `${path}.`}${detail ?? ''}` : path;
  const phrase = /** @type {Record<string, string>} */ (RULE_TEXT[lang])[rule] ?? rule;
  return lang === 'de' ? `Das Feld „${where}“ ${phrase}.` : `The field "${where}" ${phrase}.`;
}

/**
 * The message that asks a model to answer again without the listed problems.
 * @param {readonly string[]} errors
 * @param {'en' | 'de'} [locale]
 * @param {{ json?: boolean }} [options] json: the purpose expects a JSON object
 */
export function retryHint(errors, locale = 'en', options = {}) {
  const lang = locale === 'de' ? 'de' : 'en';
  const lines = [...new Set(errors)].slice(0, 8).map((e) => `- ${describeError(e, lang)}`);
  const head = lang === 'de' ? 'Deine letzte Antwort ließ sich nicht verwenden:' : 'Your last answer could not be used:';
  const tail =
    options.json === false
      ? lang === 'de'
        ? 'Antworte noch einmal vollständig und halte dich an die Vorgaben.'
        : 'Answer again in full and follow the instructions.'
      : lang === 'de'
        ? 'Antworte noch einmal, nur mit einem JSON-Objekt nach dem Schema, ohne Text davor oder danach.'
        : 'Answer again with one JSON object that follows the schema, and no text before or after it.';
  return [head, ...lines, tail].join('\n');
}
