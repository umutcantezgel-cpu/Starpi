// @ts-check
// Key-shaped strings out of text. The relay and the pools never write a header or a body to a log
// or an answer; the few strings they do produce (an error name, a ping report, a warning) still go
// through scrubSecrets, so a key that turns up somewhere unexpected is replaced before it leaves.

export const REDACTED = '[redacted]';

/**
 * Keys with a known prefix (OpenAI and compatible `sk-`, Anthropic `sk-ant-`, OpenRouter `sk-or-`,
 * ElevenLabs `sk_`, Google `AIza`, NVIDIA `nvapi-`, Groq `gsk_`, xAI `xai-`, Tavily `tvly-`).
 */
const PREFIXED = /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|sk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|nvapi-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{16,}|tvly-[A-Za-z0-9_-]{12,})/g;

/** A credential header written out as `name: value` or `name=value`. */
const HEADER_PAIR = /\b(authorization|proxy-authorization|x-api-key|x-goog-api-key|xi-api-key|x-subscription-token|api-key|x-starpi-access|cookie)(\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;"'&]+/gi;

const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A credential in a query string. */
const QUERY_PARAM = /([?&](?:key|api[_-]?key|access[_-]?token|token|auth|xi-api-key|x-goog-api-key)=)[^&\s"'#]+/gi;

/**
 * Any other long run of token characters that mixes letters and digits (keys without a prefix are
 * 30 to 40 such characters). Hyphenated runs count only from 48 characters on, so model ids such as
 * `name-4-scout-17b-16e-instruct` stay readable.
 */
const OPAQUE = /[A-Za-z0-9_-]{48,}|[A-Za-z0-9_]{28,}/g;

/**
 * The text with every key-shaped part replaced by "[redacted]". It errs on the side of removing too
 * much (a long hash looks like a key), which is the right side for log lines and error answers.
 * @param {unknown} value
 * @returns {string}
 */
export function scrubSecrets(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(HEADER_PAIR, (_, name, sep) => `${name}${sep}${REDACTED}`);
  text = text.replace(BEARER, (_, scheme) => `${scheme} ${REDACTED}`);
  text = text.replace(QUERY_PARAM, (_, head) => `${head}${REDACTED}`);
  text = text.replace(PREFIXED, REDACTED);
  return text.replace(OPAQUE, (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run));
}

/**
 * Whether a value carries a key with a known prefix. Used on query values, where the opaque-token
 * rule of scrubSecrets would also catch ordinary page tokens and search words.
 * @param {string} value
 */
export function hasKnownKey(value) {
  PREFIXED.lastIndex = 0;
  const found = PREFIXED.test(value);
  PREFIXED.lastIndex = 0;
  return found;
}
