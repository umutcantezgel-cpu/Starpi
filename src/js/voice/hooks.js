// @ts-check
// The seam between the chat and the voice features. The chat registers how voice reaches it
// (registerVoiceUi): where dictation writes, how an answer is found for its speaker button, how a
// Live turn asks the chat's model and retrieves excerpts. The voice features never import the chat,
// and nothing here loads voice code: this module ships with the first script.
//
// Wiring for the chat (one call at its start):
//   registerVoiceUi({
//     composerInput: () => document.getElementById('chatInput'),
//     getAnswer: (id) => ({ text, label, sources, grounding, question, locale }),
//     ask: (turn) => asyncIterableOfTextDeltas,       // optional: Live turns through the chat's model choice
//     retrieve: (query, { signal }) => GateSource[],   // optional: excerpts for source Live turns
//   });
// and per answer, in its action row: speakerButton(answerId); while an answer streams:
// const reader = readAloudStream(meta) (null unless auto-read is on), then reader.push(delta),
// reader.end({ grounding }) or reader.abort().
import { t } from '../i18n/index.js';
import { html, icon } from '../ui/kit.js';
import { getVoiceSettings } from './settings.js';

/** @typedef {import('../core/gate.js').GateSource} GateSource */
/** @typedef {import('../core/gate.js').GateGrounding} GateGrounding */
/** @typedef {import('./read-aloud.js').ReadableAnswer} ReadableAnswer */

/**
 * One turn of a push-to-talk Live conversation, as the chat's model is asked.
 * @typedef {object} LiveTurn
 * @property {string} text                    what the user said
 * @property {'free' | 'grounded'} mode
 * @property {GateSource[]} sources           excerpts to answer from (grounded; empty when free)
 * @property {Array<{ role: 'user' | 'assistant', text: string }>} history  earlier turns of this session
 * @property {{ mime: 'image/jpeg', data: string } | null} image  a camera picture (base64)
 * @property {string} locale
 * @property {AbortSignal} signal
 */

/** @typedef {(turn: LiveTurn) => AsyncIterable<string>} LiveAsk  yields the answer's text deltas */
/** @typedef {(query: string, options: { signal: AbortSignal, locale: string }) => Promise<GateSource[]>} LiveRetrieve */

/**
 * @typedef {object} VoiceUiHooks
 * @property {() => HTMLTextAreaElement | HTMLInputElement | null} [composerInput]  default #chatInput
 * @property {(answerId: string) => ReadableAnswer | null} [getAnswer]
 * @property {LiveAsk} [ask]
 * @property {LiveRetrieve} [retrieve]
 */

/** @type {VoiceUiHooks} */
let hooks = {};

/**
 * Registers the chat's side of the voice features; a later call replaces the hooks it names.
 * @param {VoiceUiHooks} next
 * @returns {() => void} removes these hooks again
 */
export function registerVoiceUi(next) {
  const added = { ...next };
  hooks = { ...hooks, ...added };
  return () => {
    for (const key of /** @type {(keyof VoiceUiHooks)[]} */ (Object.keys(added))) if (hooks[key] === added[key]) delete hooks[key];
  };
}

/** The hooks registered now. @returns {Readonly<VoiceUiHooks>} */
export function voiceUi() {
  return hooks;
}

/** Where dictation writes: the registered composer input, else the chat's message box. */
export function composerInput() {
  const el = hooks.composerInput?.() ?? (typeof document === 'undefined' ? null : document.getElementById('chatInput'));
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el : null;
}

/**
 * The speaker button of an answer (its action row); a click reads the answer aloud, a second one stops.
 * @param {string} answerId
 * @param {{ className?: string }} [options]
 */
export function speakerButton(answerId, options = {}) {
  const name = t('voice.read.button');
  return html`<button type="button" class="btn btn-ghost btn-icon${options.className ? ` ${options.className}` : ''}" data-action="voice-read-aloud" data-arg="${answerId}" data-voice-answer="${answerId}" aria-pressed="false" data-i18n-aria="voice.read.button" aria-label="${name}" data-i18n-title="voice.read.button" title="${name}">${icon('volume-2', 'w-4 h-4')}</button>`;
}

/**
 * @typedef {object} AnswerReader
 * @property {(delta: string) => void} push
 * @property {(final?: { grounding?: GateGrounding | null }) => void} end
 * @property {() => void} abort
 */

/**
 * Reads an answer aloud while it streams, when the user switched on "read answers aloud"; null
 * otherwise. Text that arrives before the speech code has loaded waits for it.
 * @param {Omit<ReadableAnswer, 'text'>} meta
 * @returns {AnswerReader | null}
 */
export function readAloudStream(meta) {
  if (!getVoiceSettings().autoRead) return null;
  /** @type {string[]} */
  const waiting = [];
  /** @type {import('./read-aloud.js').ReadAloudStream | null} */
  let target = null;
  /** @type {{ final?: { grounding?: GateGrounding | null } } | null} */
  let ended = null;
  let aborted = false;
  import('./speech.js')
    .then(({ createAutoRead }) => {
      if (aborted) return;
      target = createAutoRead(meta);
      for (const delta of waiting.splice(0)) target.push(delta);
      if (ended) target.end(ended.final);
    })
    .catch((err) => console.error('[starpi] read aloud failed to load', err));
  return {
    push(delta) {
      if (target) target.push(delta);
      else if (!aborted) waiting.push(delta);
    },
    end(final) {
      if (target) target.end(final);
      else ended = { final };
    },
    abort() {
      aborted = true;
      waiting.length = 0;
      target?.abort();
    },
  };
}
