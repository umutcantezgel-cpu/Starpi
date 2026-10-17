// @ts-check
// Mistral on its OpenAI-compatible endpoint. Reasoning models stream their reasoning as content
// chunks of type "thinking" (an array of text chunks) next to chunks of type "text"; tool calls
// often arrive whole in one delta. Usage comes with the last chunk without being asked for, and the
// endpoint is not known to take `stream_options`, so the request leaves it out.
import { defineQuirks } from './generic.js';

export const mistralQuirks = defineQuirks({
  id: 'mistral',
  reasoningFields: [],
  contentChunks: true,
  streamUsage: false,
});
