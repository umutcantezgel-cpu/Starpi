// @ts-check
// Speech output of this page: one speech queue for read-aloud, the voice preview and Live, fed by
// the engines the voice settings choose (sources/index.js). Reading an answer goes through
// read-aloud.js, so only gate-released sentences and the app's own notices are ever spoken. A step
// down to another engine is shown once per reading as a short notice. Loaded on first use.
import { getIntlLocale, t } from '../i18n/index.js';
import { toast } from '../ui/kit.js';
import { getPlayback } from './playback.js';
import { createReadAloudStream, readAloud } from './read-aloud.js';
import { getVoiceSettings, voiceFor } from './settings.js';
import { loadSiteOffer, pageContext, ttsEngines } from './sources/index.js';
import { createSpeechQueue, speechNotice } from './tts.js';

/** @typedef {import('./read-aloud.js').ReadableAnswer} ReadableAnswer */
/** @typedef {import('./read-aloud.js').ReadResult} ReadResult */
/** @typedef {import('./tts.js').SpeechQueue} SpeechQueue */

/** Engines with a name of their own in the step-down notice. */
const ENGINE_KEYS = Object.freeze(/** @type {Record<string, string>} */ ({ browser: 'voice.source.browser', gemini: 'voice.source.gemini', elevenlabs: 'voice.source.elevenlabs', openai: 'voice.source.openai', local: 'voice.source.local' }));

/** @type {SpeechQueue | null} */
let queue = null;
/** The answer being read, for the pressed state of its speaker button. */
let readingId = /** @type {string | null} */ (null);
let fallbackShown = false;

/** The page's speech queue. */
export function speechQueue() {
  if (queue) return queue;
  queue = createSpeechQueue({
    engines: () => ttsEngines(pageContext),
    locale: () => getIntlLocale(),
    voice: (engine, locale) => voiceFor(getVoiceSettings(), /** @type {import('./catalog.js').TtsSourceId} */ (engine), locale),
    rate: () => getVoiceSettings().rate,
    onFallback: ({ from, to }) => {
      if (fallbackShown) return;
      fallbackShown = true;
      if (to) toast({ key: 'voice.fallback.to', params: { from: labelOf(from), to: labelOf(to) } }, { tone: 'warn' });
      else toast('voice.fallback.none', { tone: 'warn' });
    },
  });
  queue.onState((speaking) => {
    if (typeof document !== 'undefined') document.getElementById('voiceStopBtn')?.classList.toggle('hidden', !speaking);
    if (!speaking) {
      fallbackShown = false;
      markReading(null);
    }
  });
  return queue;
}

/** @param {string} engine */
const labelOf = (engine) => (ENGINE_KEYS[engine] ? t(ENGINE_KEYS[engine]) : engine);

/**
 * Marks the speaker button of the answer being read (aria-pressed).
 * @param {string | null} id
 */
function markReading(id) {
  readingId = id;
  if (typeof document === 'undefined') return;
  for (const btn of document.querySelectorAll('[data-voice-answer]')) btn.setAttribute('aria-pressed', String(id !== null && btn.getAttribute('data-voice-answer') === id));
}

/** Waits briefly for what the site offers, so its voices count from the first reading. */
async function siteReady() {
  await Promise.race([loadSiteOffer(), new Promise((resolve) => setTimeout(resolve, 1500))]);
}

/**
 * Reads an answer aloud (a second call for the same answer stops it).
 * @param {ReadableAnswer} answer
 * @param {{ id?: string | null }} [options]
 * @returns {Promise<ReadResult | null>} null when it only stopped a reading
 */
export async function readAnswerAloud(answer, options = {}) {
  const q = speechQueue();
  const id = options.id ?? null;
  if (q.speaking()) {
    q.stop();
    if (id !== null && id === readingId) return null;
    await q.idle();
  }
  await getPlayback().unlock();
  await siteReady();
  const result = readAloud(answer, { queue: q, locale: answer.locale ?? getIntlLocale() });
  markReading(id);
  return result;
}

/**
 * Reads an answer while it streams (auto-read).
 * @param {Omit<ReadableAnswer, 'text'>} meta
 */
export function createAutoRead(meta) {
  void siteReady();
  return createReadAloudStream(meta, { queue: speechQueue(), locale: meta.locale ?? getIntlLocale() });
}

/** Speaks the fixed sample sentence with the current voice settings. */
export async function previewVoice() {
  const q = speechQueue();
  q.stop();
  await q.idle();
  await getPlayback().unlock();
  await siteReady();
  q.enqueue(speechNotice('voice.preview.sample', {}, getIntlLocale()));
}

/** Stops whatever is being spoken. */
export function stopSpeaking() {
  queue?.stop();
  getPlayback().flush();
}
