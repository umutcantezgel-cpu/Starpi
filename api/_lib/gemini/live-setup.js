// @ts-check
// The setup of a free Live conversation, built on the server and locked into the session's
// ephemeral token, so the browser cannot change model, voice or instruction. Written from the
// public Gemini Live API reference: the model answers with native audio in a prebuilt voice, the
// service transcribes both sides, detects when the user has finished speaking, and compresses the
// context so a longer conversation keeps going. The instruction is the app's own and says what the
// conversation is: free talk whose answers nobody checks against the user's documents.
import { isGeminiVoice } from '../../../src/js/voice/catalog.js';

/** The instruction of a free Live conversation, per language. */
export const LIVE_INSTRUCTIONS = Object.freeze({
  en: [
    'You are the voice assistant of Starpi, a knowledge app, in a free spoken conversation.',
    'Your answers are not checked against the user\'s documents. Say so when you are unsure, and never make up facts, figures, quotes or sources.',
    'Answer in the language the user speaks, in short spoken sentences without lists, tables, links or markup.',
    'When the user shows a picture, describe only what can actually be seen in it.',
  ].join(' '),
  de: [
    'Du bist die Sprachassistenz von Starpi, einer Wissens-App, in einem freien gesprochenen Gespräch.',
    'Deine Antworten werden nicht mit den Dokumenten des Nutzers abgeglichen. Sag es, wenn du unsicher bist, und erfinde keine Fakten, Zahlen, Zitate oder Quellen.',
    'Antworte in der Sprache, in der der Nutzer spricht, in kurzen gesprochenen Sätzen ohne Listen, Tabellen, Links oder Auszeichnungen.',
    'Zeigt der Nutzer ein Bild, beschreibe nur, was darauf wirklich zu sehen ist.',
  ].join(' '),
});

/** BCP 47 language of the speech output per interface language. */
const SPEECH_LANGUAGE = Object.freeze({ en: 'en-US', de: 'de-DE' });

/**
 * @typedef {object} LiveSetupInput
 * @property {string} model      Live model id (without "models/")
 * @property {string} voice      a prebuilt Gemini voice
 * @property {'en' | 'de'} locale
 */

/**
 * The BidiGenerateContentSetup of a free Live conversation.
 * @param {LiveSetupInput} input
 */
export function buildLiveSetup({ model, voice, locale }) {
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) throw new TypeError('buildLiveSetup: invalid model id');
  if (!isGeminiVoice(voice)) throw new TypeError('buildLiveSetup: not a prebuilt voice');
  const lang = locale === 'de' ? 'de' : 'en';
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: 0.6,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: SPEECH_LANGUAGE[lang] },
    },
    systemInstruction: { parts: [{ text: LIVE_INSTRUCTIONS[lang] }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
    contextWindowCompression: { slidingWindow: {} },
  };
}
