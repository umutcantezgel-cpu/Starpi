// @ts-check
// Read aloud: an answer goes to the speech queue only through a sentence gate (core/gate.js).
//   - A free answer (label 'free', or no label) passes the free gate (links and foreign characters
//     are held back) and is preceded by the spoken notice "Free answer, not checked".
//   - A grounded answer ('grounded', 'mixed') passes the source gate with the excerpts the answer
//     was given: a sentence with a number is spoken only when the excerpt it cites holds that number.
//     A web answer ('web') passes the web gate with its grounding segments.
//   - After the answer, "N sentences withheld" says how much was not spoken (when anything was).
// The screen keeps showing the whole answer with its flags; this module only decides what is heard.
//
// readAloud() takes a complete answer. createReadAloudStream() reads an answer while it streams:
// each unit is spoken as soon as the gate can judge it, the count at the end. A stop() of the queue
// (the stop button, another reading, the voice preview) ends a streaming reading for good: what the
// answer still streams is not spoken, and no count follows.
import { createSentenceGate } from '../core/gate.js';
import { speechNotice } from './tts.js';

/** @typedef {import('../core/gate.js').GateSource} GateSource */
/** @typedef {import('../core/gate.js').GateGrounding} GateGrounding */
/** @typedef {import('../core/gate.js').GateMode} GateMode */
/** @typedef {import('../core/gate.js').Released} Released */
/** @typedef {import('./tts.js').SpeechQueue} SpeechQueue */

/**
 * An answer as the chat knows it.
 * @typedef {object} ReadableAnswer
 * @property {string} text                      the answer as streamed (Markdown, citation labels included)
 * @property {'free' | 'grounded' | 'mixed' | 'web' | null} [label]
 * @property {GateSource[]} [sources]           the excerpts the answer was given (grounded)
 * @property {GateGrounding | null} [grounding] web answers
 * @property {string} [question]                identifiers in it count as given
 * @property {string} [locale]                  language of the answer; the interface language when left out
 */

/**
 * @typedef {object} ReadResult
 * @property {GateMode} mode
 * @property {number} spoken      units handed to the queue
 * @property {number} withheld
 * @property {boolean} stopped    the queue was stopped while the answer streamed
 */

/**
 * The gate mode of an answer label.
 * @param {ReadableAnswer['label']} label
 * @returns {GateMode}
 */
export function gateModeFor(label) {
  if (label === 'grounded' || label === 'mixed') return 'sources';
  if (label === 'web') return 'web';
  return 'free';
}

/**
 * @typedef {object} ReadAloudStream
 * @property {(delta: string) => number} push        units spoken from this delta
 * @property {(final?: { grounding?: GateGrounding | null }) => ReadResult} end
 * @property {() => void} abort                       the answer stopped: open units are dropped
 */

/**
 * Reads an answer while it streams.
 * @param {Omit<ReadableAnswer, 'text'>} meta
 * @param {{ queue: SpeechQueue, locale: string }} deps
 * @returns {ReadAloudStream}
 */
export function createReadAloudStream(meta, { queue, locale }) {
  const mode = gateModeFor(meta.label ?? null);
  const lang = meta.locale ?? locale;
  const gate = createSentenceGate({ mode, locale: lang, sources: meta.sources ?? [], question: meta.question ?? '', grounding: meta.grounding, identifiers: 'verbatim' });
  let spoken = 0;
  let noticed = false;
  const epoch = queue.epoch();
  let stopped = false;
  /** Whether the queue was stopped since this reading began (the gate is then dropped once). */
  const over = () => {
    if (!stopped && queue.epoch() !== epoch) {
      stopped = true;
      gate.abort();
    }
    return stopped;
  };
  /** @param {Released[]} units */
  const speak = (units) => {
    let n = 0;
    for (const unit of units) {
      if (unit.kind === 'code' || !unit.spoken.trim()) continue;
      if (mode === 'free' && !noticed) {
        queue.enqueue(speechNotice('voice.read.free_notice', {}, lang));
        noticed = true;
      }
      if (queue.enqueue(unit)) n += 1;
    }
    spoken += n;
    return n;
  };
  return {
    push: (delta) => (over() ? 0 : speak(gate.push(String(delta ?? '')))),
    end(final) {
      if (over()) return { mode, spoken, withheld: 0, stopped: true };
      const result = gate.end(final);
      speak(result.released);
      const withheld = result.counts.withheld;
      if (mode === 'free' && !noticed && spoken === 0) {
        // A free answer with nothing to speak still says what it is.
        queue.enqueue(speechNotice('voice.read.free_notice', {}, lang));
        noticed = true;
      }
      if (withheld > 0) queue.enqueue(speechNotice('voice.read.withheld', { count: withheld }, lang));
      else if (mode !== 'free' && spoken === 0) queue.enqueue(speechNotice('voice.read.nothing', {}, lang));
      return { mode, spoken, withheld, stopped: false };
    },
    abort() {
      if (!stopped) gate.abort();
      stopped = true;
    },
  };
}

/**
 * Reads a complete answer.
 * @param {ReadableAnswer} answer
 * @param {{ queue: SpeechQueue, locale: string }} deps
 * @returns {ReadResult}
 */
export function readAloud(answer, deps) {
  const stream = createReadAloudStream(answer, deps);
  stream.push(answer.text ?? '');
  return stream.end({ grounding: answer.grounding ?? null });
}
