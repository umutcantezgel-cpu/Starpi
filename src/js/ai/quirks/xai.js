// @ts-check
// xAI (Grok) on its OpenAI-compatible Chat Completions endpoint. Reasoning text arrives in
// `reasoning_content`; models with an effort control (the catalog marks them `reasoning: 'effort'`)
// take `reasoning_effort` with two levels.
//
// Web search: xAI offers search as server-side tools, and the request shape of that feature has
// changed before. XAI_SEARCH_VERIFIED stays false until the shape below is checked with a real key
// (`npm run providers:ping`); until then a search request is sent without search, and the catalog
// keeps `search: 'xai-tools'` only as a capability note.
import { defineQuirks } from './generic.js';

/** Flip only after checking the search request shape against the live API. */
export const XAI_SEARCH_VERIFIED = false;

export const xaiQuirks = defineQuirks({
  id: 'xai',
  reasoningFields: ['reasoning_content'],
  shape(body, req, caps) {
    if (caps.reasoning === 'effort' && req.thinking && req.thinking.mode !== 'auto') {
      const effort = req.thinking.effort;
      body.reasoning_effort = req.thinking.mode === 'off' || effort === 'low' || effort === 'medium' ? 'low' : 'high';
    }
    if (XAI_SEARCH_VERIFIED && req.search?.enabled) {
      // Unverified shape, kept behind the flag above.
      body.search_parameters = { mode: 'auto', ...(req.search.maxUses ? { max_search_results: req.search.maxUses } : {}) };
    }
  },
});
