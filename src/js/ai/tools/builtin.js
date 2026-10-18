// @ts-check
// The built-in client tools of the free chat. All of them only read, so none needs an approval:
//   datetime          the current date and time, in the user's or a named time zone
//   calculator        arithmetic through a small parser of its own (never eval or Function)
//   workspace_search  passages from the files on this device
//   memory_lookup     facts the user asked the assistant to remember (empty until memory exists)
//   web_search        the configured search API (search.js)
// Each tool gets what it reads as a dependency, so the tools run the same in the browser and in
// tests. Results are short JSON texts; the loop quotes them as untrusted data.
/** @typedef {import('./registry.js').ToolDef} ToolDef */
/** @typedef {import('./registry.js').ToolOutput} ToolOutput */
/** @typedef {import('../search.js').SearchResult} SearchResult */

/**
 * @typedef {object} BuiltinDeps
 * @property {() => Date} [now]
 * @property {() => string | undefined} [timeZone]   the user's time zone
 * @property {(query: string, limit: number) => Promise<Array<{ docName: string, chunkIndex: number, text: string }>>} [searchWorkspace]
 * @property {(query: string, limit: number) => Promise<Array<{ text: string, updatedAt?: string }>>} [memoryLookup]
 * @property {(query: string, count: number, signal: AbortSignal) => Promise<SearchResult[]>} [webSearch]
 */

export const BUILTIN_TOOL_NAMES = Object.freeze(['datetime', 'calculator', 'workspace_search', 'memory_lookup', 'web_search']);

/** An error of the calculator, with a code the model can read. */
export class CalcError extends Error {
  /** @param {'syntax' | 'unknown_name' | 'too_long' | 'not_finite' | 'arguments'} code @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CalcError';
    this.code = code;
  }
}

const MAX_EXPRESSION_CHARS = 500;
const MAX_TOKENS = 300;
const MAX_DEPTH = 60;

/** @type {Readonly<Record<string, number>>} */
const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: 2 * Math.PI });

/** @type {Readonly<Record<string, { min: number, max: number, fn: (...a: number[]) => number }>>} */
const FUNCTIONS = Object.freeze({
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  cbrt: { min: 1, max: 1, fn: Math.cbrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  trunc: { min: 1, max: 1, fn: Math.trunc },
  round: {
    min: 1,
    max: 2,
    fn: (x, digits = 0) => {
      const f = 10 ** Math.max(0, Math.min(12, Math.trunc(digits)));
      return Math.round(x * f) / f;
    },
  },
  min: { min: 1, max: 50, fn: Math.min },
  max: { min: 1, max: 50, fn: Math.max },
  pow: { min: 2, max: 2, fn: Math.pow },
  hypot: { min: 1, max: 50, fn: Math.hypot },
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log: { min: 1, max: 1, fn: Math.log10 },
  log2: { min: 1, max: 1, fn: Math.log2 },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos },
  atan: { min: 1, max: 1, fn: Math.atan },
});

/**
 * @typedef {{ type: 'num', value: number } | { type: 'name', value: string } | { type: 'op', value: string }} Token
 */

/**
 * @param {string} text
 * @returns {Token[]}
 */
function tokenize(text) {
  /** @type {Token[]} */
  const out = [];
  const src = text.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ type: 'num', value: Number(num[0]) });
      i += num[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))?.[0] ?? ch;
      out.push({ type: 'name', value: name.toLowerCase() });
      i += name.length;
    } else if ('+-*/%^(),'.includes(ch)) {
      // "**" is a power, as in many languages.
      if (ch === '*' && src[i + 1] === '*') {
        out.push({ type: 'op', value: '^' });
        i += 2;
      } else {
        out.push({ type: 'op', value: ch });
        i += 1;
      }
    } else {
      throw new CalcError('syntax', `unexpected character ${JSON.stringify(ch)}`);
    }
    if (out.length > MAX_TOKENS) throw new CalcError('too_long');
  }
  return out;
}

/**
 * Evaluates an arithmetic expression: numbers, + - * / % ^ (or **), parentheses, unary signs, the
 * constants pi, e and tau, and the functions of FUNCTIONS. A recursive-descent parser; nothing in
 * the text is ever run as code.
 * @param {string} expression
 * @returns {number}
 */
export function evaluateExpression(expression) {
  const text = String(expression ?? '');
  if (!text.trim()) throw new CalcError('syntax', 'empty expression');
  if (text.length > MAX_EXPRESSION_CHARS) throw new CalcError('too_long');
  const tokens = tokenize(text);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  /** @param {string} op */
  const isOp = (op) => peek()?.type === 'op' && peek()?.value === op;
  /** @param {string} op */
  const expect = (op) => {
    if (!isOp(op)) throw new CalcError('syntax', `${op} expected`);
    pos += 1;
  };
  const enter = () => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new CalcError('too_long');
  };

  /** @returns {number} */
  const expr = () => {
    enter();
    let value = term();
    while (isOp('+') || isOp('-')) {
      const op = /** @type {Token} */ (tokens[pos++]).value;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    depth -= 1;
    return value;
  };
  /** @returns {number} */
  const term = () => {
    let value = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = /** @type {Token} */ (tokens[pos++]).value;
      const right = unary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  };
  /** @returns {number} */
  const unary = () => {
    if (isOp('-') || isOp('+')) {
      const op = /** @type {Token} */ (tokens[pos++]).value;
      enter();
      const value = unary();
      depth -= 1;
      return op === '-' ? -value : value;
    }
    return power();
  };
  /** @returns {number} */
  const power = () => {
    const base = primary();
    if (!isOp('^')) return base;
    pos += 1;
    enter();
    // Right-associative, and binds tighter than a sign on its left: -2^2 = -4, 2^-1 = 0.5.
    const exponent = unary();
    depth -= 1;
    return base ** exponent;
  };
  /** @returns {number} */
  const primary = () => {
    const tok = peek();
    if (!tok) throw new CalcError('syntax', 'unexpected end');
    if (tok.type === 'num') {
      pos += 1;
      return tok.value;
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos += 1;
      const value = expr();
      expect(')');
      return value;
    }
    if (tok.type === 'name') {
      pos += 1;
      if (isOp('(')) {
        const fn = Object.hasOwn(FUNCTIONS, tok.value) ? FUNCTIONS[tok.value] : null;
        if (!fn) throw new CalcError('unknown_name', tok.value);
        pos += 1;
        /** @type {number[]} */
        const args = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) {
            pos += 1;
            args.push(expr());
          }
        }
        expect(')');
        if (args.length < fn.min || args.length > fn.max) throw new CalcError('arguments', tok.value);
        return fn.fn(...args);
      }
      if (Object.hasOwn(CONSTANTS, tok.value)) return CONSTANTS[tok.value];
      throw new CalcError('unknown_name', tok.value);
    }
    throw new CalcError('syntax', `unexpected ${JSON.stringify(tok.value)}`);
  };

  const value = expr();
  if (pos < tokens.length) throw new CalcError('syntax', `unexpected ${JSON.stringify(tokens[pos].value)}`);
  if (!Number.isFinite(value)) throw new CalcError('not_finite');
  return value;
}

/**
 * A number as the calculator reports it: rounded to 12 significant digits, so 0.1 + 0.2 is 0.3.
 * @param {number} value
 */
export function formatResult(value) {
  return Number(value.toPrecision(12));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
function limit(value, fallback, max) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(max, value) : fallback;
}

/**
 * @param {unknown} value
 * @returns {ToolOutput}
 */
const ok = (value) => ({ content: JSON.stringify(value) });
/**
 * @param {string} error
 * @returns {ToolOutput}
 */
const failed = (error) => ({ content: JSON.stringify({ error }), isError: true });

/**
 * Whether a text names a time zone this runtime knows.
 * @param {string} zone
 */
function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The built-in tools with their dependencies. Tools whose dependency is missing are left out
 * (web_search without a search service).
 * @param {BuiltinDeps} [deps]
 * @returns {ToolDef[]}
 */
export function builtinTools(deps = {}) {
  const now = deps.now ?? (() => new Date());
  /** @type {ToolDef[]} */
  const tools = [
    {
      name: 'datetime',
      origin: 'builtin',
      labelKey: 'tools.builtin.datetime',
      effect: 'read',
      description: "Returns the current date and time: ISO 8601 in UTC, the local date and time and the weekday in the user's time zone or in a named IANA time zone.",
      schema: { type: 'object', properties: { timeZone: { type: 'string', description: 'IANA time zone such as Europe/Berlin; omit for the user\'s own', maxLength: 64 } }, additionalProperties: false },
      async run(args) {
        const zone = typeof args.timeZone === 'string' && args.timeZone ? args.timeZone : (deps.timeZone?.() ?? 'UTC');
        if (!validZone(zone)) return failed(`unknown time zone ${zone.slice(0, 64)}`);
        const at = now();
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at);
        const weekday = new Intl.DateTimeFormat('en', { timeZone: zone, weekday: 'long' }).format(at);
        return ok({ utc: at.toISOString(), local: local.replace(',', ''), weekday, timeZone: zone, unix: Math.floor(at.getTime() / 1000) });
      },
    },
    {
      name: 'calculator',
      origin: 'builtin',
      labelKey: 'tools.builtin.calculator',
      effect: 'read',
      description: 'Evaluates an arithmetic expression exactly: + - * / % ^, parentheses, pi, e, and sqrt, cbrt, abs, round(x, digits), floor, ceil, trunc, min, max, pow, hypot, exp, ln, log (base 10), log2, sin, cos, tan, asin, acos, atan (radians).',
      schema: { type: 'object', properties: { expression: { type: 'string', description: 'For example (17.5 * 3) / 2 or sqrt(2) ^ 2', maxLength: MAX_EXPRESSION_CHARS } }, required: ['expression'], additionalProperties: false },
      async run(args) {
        try {
          const expression = String(args.expression);
          return ok({ expression, result: formatResult(evaluateExpression(expression)) });
        } catch (err) {
          return failed(err instanceof CalcError ? err.message : 'syntax');
        }
      },
    },
    {
      name: 'workspace_search',
      origin: 'builtin',
      labelKey: 'tools.builtin.workspace_search',
      effect: 'read',
      description: "Searches the user's files on this device and returns the best matching passages with their file name.",
      schema: { type: 'object', properties: { query: { type: 'string', maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
      async run(args) {
        if (!deps.searchWorkspace) return ok({ results: [], note: 'No files are on this device.' });
        const hits = await deps.searchWorkspace(String(args.query), limit(args.limit, 5, 8));
        if (!hits.length) return ok({ results: [], note: 'Nothing in the files matches.' });
        return ok({ results: hits.map((h) => ({ file: h.docName, part: h.chunkIndex + 1, text: h.text.slice(0, 800) })) });
      },
    },
    {
      name: 'memory_lookup',
      origin: 'builtin',
      labelKey: 'tools.builtin.memory_lookup',
      effect: 'read',
      description: 'Looks up facts the user asked the assistant to remember. They may be outdated.',
      schema: { type: 'object', properties: { query: { type: 'string', maxLength: 400 } }, required: ['query'], additionalProperties: false },
      async run(args) {
        if (!deps.memoryLookup) return ok({ facts: [], note: 'Memory is off.' });
        const facts = await deps.memoryLookup(String(args.query), 8);
        return ok({ facts: facts.slice(0, 8).map((f) => ({ text: f.text.slice(0, 400), ...(f.updatedAt ? { updated: f.updatedAt } : {}) })), note: 'User notes (may be outdated).' });
      },
    },
  ];
  if (deps.webSearch) {
    const search = deps.webSearch;
    tools.push({
      name: 'web_search',
      origin: 'builtin',
      labelKey: 'tools.builtin.web_search',
      effect: 'read',
      description: 'Searches the web and returns numbered results (title, address, snippet). Cite a result you use with its address.',
      schema: { type: 'object', properties: { query: { type: 'string', maxLength: 400 }, count: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
      async run(args, ctx) {
        const results = await search(String(args.query), limit(args.count, 5, 10), ctx.signal);
        if (!results.length) return ok({ results: [], note: 'The search found nothing.' });
        return {
          content: JSON.stringify({ results: results.map((r, i) => ({ n: i + 1, title: r.title, url: r.url, snippet: r.snippet })) }),
          sources: results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
        };
      },
    });
  }
  return tools;
}
