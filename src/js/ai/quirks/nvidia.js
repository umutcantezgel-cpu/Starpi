// @ts-check
// NVIDIA NIM on its OpenAI-compatible endpoint (normally reached through the site's pool, which
// adds the catalog's fixed upstream fields itself; a user key goes through the relay). Reasoning
// models stream `reasoning_content`; a model served without a reasoning parser writes <think> tags
// into the content instead, so those are read as reasoning too. The catalog's fixed extras (such as
// switching a model's thinking off) are added here as well, so a relayed request behaves like a
// pooled one, and the output budget defaults to the catalog's value per model.
import { findNvidiaModel } from '../../models/nvidia-catalog.js';
import { defineQuirks } from './generic.js';

export const nvidiaQuirks = defineQuirks({
  id: 'nvidia',
  reasoningFields: ['reasoning_content'],
  thinkTags: true,
  defaultMaxTokens: (model) => findNvidiaModel(model)?.defaultMaxTokens,
  shape(body, req) {
    const upstream = findNvidiaModel(req.model)?.upstream;
    if (upstream) for (const [key, value] of Object.entries(upstream)) if (!(key in body)) body[key] = value;
  },
});
