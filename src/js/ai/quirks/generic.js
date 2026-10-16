// @ts-check
// The quirks object of an OpenAI-compatible endpoint and the defaults every provider starts from.
// A quirks object describes what one provider does differently from plain Chat Completions: where
// reasoning arrives, extra headers, request fields for reasoning and search, how usage is
// reported. A new compatible provider is a catalog entry plus one of these.

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../contract.js').ProviderId} ProviderId */

/**
 * @typedef {object} ChatQuirks
 * @property {string} id
 * @property {string} [path]                    request path below the API root (default /v1/chat/completions)
 * @property {Readonly<Record<string, string>>} [headers]  extra request headers
 * @property {ReadonlyArray<'reasoning_content' | 'reasoning'>} reasoningFields  delta fields that carry reasoning text, in order of preference
 * @property {boolean} thinkTags                content may carry reasoning inside <think> tags
 * @property {boolean} contentChunks            content may be an array of typed chunks (text, thinking)
 * @property {boolean} streamUsage              ask for usage on the last chunk (stream_options.include_usage)
 * @property {boolean} filesAsParts             PDFs go as file parts (otherwise they are left out)
 * @property {boolean} replayReasoningDetails   keep structured reasoning (reasoning_details) as opaque and send it back
 * @property {'openai-chat' | 'local'} stopDialect
 * @property {(body: Record<string, any>, req: AiRequest, caps: Caps) => void} [shape]  adds the provider's own request fields
 * @property {(chunk: Record<string, any>) => unknown} [usageOf]  where a chunk carries usage, when not in `usage`
 * @property {(model: string) => number | undefined} [defaultMaxTokens]  `max_tokens` when the request names none
 */

/** Plain Chat Completions, as OpenAI and most compatible servers speak it. */
export const GENERIC_QUIRKS = /** @type {Readonly<ChatQuirks>} */ (
  Object.freeze({
    id: 'generic',
    reasoningFields: Object.freeze(/** @type {const} */ (['reasoning_content', 'reasoning'])),
    thinkTags: false,
    contentChunks: false,
    streamUsage: true,
    filesAsParts: false,
    replayReasoningDetails: false,
    stopDialect: 'openai-chat',
  })
);

/**
 * A quirks object from the defaults and the given differences.
 * @param {Partial<ChatQuirks> & { id: string }} differences
 * @returns {Readonly<ChatQuirks>}
 */
export function defineQuirks(differences) {
  return Object.freeze({ ...GENERIC_QUIRKS, ...differences });
}

/**
 * The effort level of a request in the three-step scale most providers take.
 * @param {AiRequest} req
 * @param {'low' | 'medium' | 'high'} [fallback]
 * @returns {'low' | 'medium' | 'high'}
 */
export function threeStepEffort(req, fallback = 'medium') {
  const effort = req.thinking?.effort;
  if (effort === 'max') return 'high';
  return effort ?? fallback;
}
