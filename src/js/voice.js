// @ts-check
// The voice entry other modules import (kept stable through 3.x): initVoice() registers the voice
// actions of the page, recognizeOnce() and speechRecognitionCtor() are the browser's speech
// recognition. The voice features themselves live in src/js/voice/ and load on first use.
export { initVoice } from './voice/entry.js';
export { recognizeOnce, speechRecognitionCtor } from './voice/recognition.js';
