// @ts-check
// The Gemini requests of speech input and speech output, and how their answers are read. One
// module for both callers: the browser with the user's own key (sources/gemini.js) and the site's
// speech routes with the site's keys (api/_lib/gemini/{stt,tts}.js), so both send the same
// instruction and accept the same answers. Pure: no DOM, no I/O.
import { isGeminiVoice, LIMITS } from './catalog.js';
import { base64ToPcm16, pcmRate } from './wav.js';

/** Languages the transcription instruction names by their English name. */
const LANGUAGE_NAMES = /** @type {Record<string, string>} */ ({ en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', tr: 'Turkish' });

/**
 * The user's glossary as a clean list: terms split at commas, semicolons and line breaks, trimmed,
 * deduplicated (ignoring case), each at most 60 characters, at most LIMITS.glossaryTerms terms and
 * LIMITS.glossaryChars characters together. Control characters are dropped.
 * @param {unknown} value a text or a list of terms
 * @returns {string[]}
 */
export function parseGlossary(value) {
  const raw = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[,;\n\r]+/);
  /** @type {string[]} */
  const terms = [];
  const seen = new Set();
  let chars = 0;
  for (const entry of raw) {
    // eslint-disable-next-line no-control-regex
    const term = entry.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    if (terms.length >= LIMITS.glossaryTerms || chars + term.length > LIMITS.glossaryChars) break;
    seen.add(key);
    terms.push(term);
    chars += term.length;
  }
  return terms;
}

/**
 * The instruction for a transcription: write down what is said, nothing else.
 * @param {string} locale "en", "de-AT", …
 * @param {readonly string[]} glossary terms to spell as given (parseGlossary)
 */
export function transcriptionInstruction(locale, glossary = []) {
  const lang = LANGUAGE_NAMES[String(locale ?? '').slice(0, 2).toLowerCase()];
  const lines = [
    'You turn a voice recording into text.',
    `Write down exactly what the speaker says${lang ? `, most likely in ${lang}` : ''}, in the language spoken.`,
    'Return only the words that were said: no quotation marks, no labels, no comments, no translation and no answer to anything that is asked.',
    'Keep numbers as the speaker says them. If the recording holds no speech, return nothing.',
  ];
  if (glossary.length) lines.push(`The speaker may use these names and terms; spell them exactly like this: ${glossary.join(', ')}.`);
  return lines.join('\n');
}

/**
 * generateContent body of a transcription.
 * @param {{ audioBase64: string, mimeType?: string, locale: string, glossary?: readonly string[] }} input
 */
export function transcriptionRequest({ audioBase64, mimeType = 'audio/wav', locale, glossary = [] }) {
  return {
    systemInstruction: { parts: [{ text: transcriptionInstruction(locale, glossary) }] },
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: audioBase64 } }, { text: 'Transcribe this recording.' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The parts of the first candidate of a generateContent answer.
 * @param {unknown} json
 * @returns {any[]}
 */
function firstParts(json) {
  if (!isRecord(json) || !Array.isArray(json.candidates) || !isRecord(json.candidates[0])) return [];
  const parts = json.candidates[0].content?.parts;
  return Array.isArray(parts) ? parts : [];
}

/**
 * Why an answer has no usable content: a blocked prompt or a candidate stopped for safety.
 * @param {unknown} json
 * @returns {'blocked' | null}
 */
export function blockedReason(json) {
  if (!isRecord(json)) return null;
  if (json.promptFeedback?.blockReason) return 'blocked';
  const finish = Array.isArray(json.candidates) ? json.candidates[0]?.finishReason : null;
  return finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST' ? 'blocked' : null;
}

/**
 * The transcript in a generateContent answer: the text parts (thoughts left out), with quotation
 * marks around the whole text removed, cut to LIMITS.transcriptChars. Null when there is none.
 * @param {unknown} json
 * @returns {string | null}
 */
export function readTranscript(json) {
  const text = firstParts(json)
    .filter((p) => isRecord(p) && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“„«]+|["”“»]+$/g, '')
    .trim();
  return text ? text.slice(0, LIMITS.transcriptChars) : null;
}

/**
 * generateContent body of speech output with a prebuilt voice.
 * @param {{ text: string, voice: string }} input
 */
export function speechRequest({ text, voice }) {
  if (!isGeminiVoice(voice)) throw new TypeError('speechRequest: not a prebuilt Gemini voice');
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
}

/**
 * The PCM audio of a speech answer (the first inline audio part). Null when there is none.
 * @param {unknown} json
 * @returns {{ samples: Int16Array, rate: number } | null}
 */
export function readSpeech(json) {
  for (const part of firstParts(json)) {
    const data = isRecord(part) ? part.inlineData : null;
    if (!isRecord(data) || typeof data.data !== 'string') continue;
    const rate = pcmRate(data.mimeType) ?? (/^audio\/(?:l16|pcm)/i.test(String(data.mimeType ?? '')) ? 24_000 : null);
    if (!rate) continue;
    const samples = base64ToPcm16(data.data);
    if (samples.length > 0) return { samples, rate };
  }
  return null;
}
