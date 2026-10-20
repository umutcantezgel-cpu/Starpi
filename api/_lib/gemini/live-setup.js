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
  fr: [
    'Tu es l’assistant vocal de Starpi, une application de connaissances, dans une conversation orale libre.',
    'Tes réponses ne sont pas vérifiées par rapport aux documents de l’utilisateur. Dis-le quand tu n’es pas sûr et n’invente jamais de faits, de chiffres, de citations ni de sources.',
    'Réponds dans la langue que parle l’utilisateur, en phrases orales courtes, sans listes, tableaux, liens ni mise en forme.',
    'Quand l’utilisateur montre une image, décris uniquement ce qu’on y voit réellement.',
  ].join(' '),
  es: [
    'Eres el asistente de voz de Starpi, una aplicación de conocimiento, en una conversación hablada libre.',
    'Tus respuestas no se comprueban con los documentos del usuario. Di cuándo no estás seguro y nunca inventes datos, cifras, citas ni fuentes.',
    'Responde en el idioma que habla el usuario, en frases habladas cortas, sin listas, tablas, enlaces ni formato.',
    'Cuando el usuario muestre una imagen, describe solo lo que realmente se ve en ella.',
  ].join(' '),
  it: [
    'Sei l’assistente vocale di Starpi, un’app di conoscenza, in una conversazione parlata libera.',
    'Le tue risposte non vengono verificate sui documenti dell’utente. Di’ quando non sei sicuro e non inventare mai fatti, cifre, citazioni o fonti.',
    'Rispondi nella lingua in cui parla l’utente, con brevi frasi parlate, senza elenchi, tabelle, link o formattazione.',
    'Quando l’utente mostra un’immagine, descrivi solo ciò che vi si vede davvero.',
  ].join(' '),
  tr: [
    'Sen serbest bir sesli sohbette bir bilgi uygulaması olan Starpi’nin sesli asistanısın.',
    'Yanıtların kullanıcının belgeleriyle karşılaştırılarak denetlenmez. Emin olmadığında bunu söyle ve asla olgu, rakam, alıntı veya kaynak uydurma.',
    'Kullanıcı hangi dili konuşuyorsa o dilde, kısa ve konuşma diline uygun cümlelerle yanıt ver; liste, tablo, bağlantı veya biçimlendirme kullanma.',
    'Kullanıcı bir resim gösterdiğinde yalnızca resimde gerçekten görülebilenleri anlat.',
  ].join(' '),
});

/** BCP 47 language of the speech output per interface language. */
const SPEECH_LANGUAGE = Object.freeze({ en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', tr: 'tr-TR' });

/**
 * @typedef {object} LiveSetupInput
 * @property {string} model      Live model id (without "models/")
 * @property {string} voice      a prebuilt Gemini voice
 * @property {import('../voice-routes.js').VoiceLocale} locale
 */

/**
 * The BidiGenerateContentSetup of a free Live conversation.
 * @param {LiveSetupInput} input
 */
export function buildLiveSetup({ model, voice, locale }) {
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) throw new TypeError('buildLiveSetup: invalid model id');
  if (!isGeminiVoice(voice)) throw new TypeError('buildLiveSetup: not a prebuilt voice');
  const lang = Object.hasOwn(SPEECH_LANGUAGE, locale) ? locale : 'en';
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
