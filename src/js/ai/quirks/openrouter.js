// @ts-check
// OpenRouter: one OpenAI-compatible endpoint in front of many providers. Requests carry the
// attribution headers OpenRouter asks apps to send (HTTP-Referer, X-Title). Reasoning is asked for
// with `reasoning: { effort }` and streams as `reasoning` text plus structured `reasoning_details`,
// which some upstream models need back unchanged in later turns, so they are kept as opaque state
// and replayed. Web search is the `web` plugin; its sources arrive as url_citation annotations.
// PDFs travel as file parts.
import { defineQuirks, threeStepEffort } from './generic.js';

export const OPENROUTER_REFERER = 'https://www.starpi.app';
export const OPENROUTER_TITLE = 'Starpi';

/**
 * @param {{ referer?: string, title?: string }} [options] the app's public address and name
 */
export function createOpenRouterQuirks(options = {}) {
  return defineQuirks({
    id: 'openrouter',
    headers: Object.freeze({ 'HTTP-Referer': options.referer ?? OPENROUTER_REFERER, 'X-Title': options.title ?? OPENROUTER_TITLE }),
    reasoningFields: ['reasoning'],
    filesAsParts: true,
    replayReasoningDetails: true,
    shape(body, req, caps) {
      const mode = req.thinking?.mode ?? 'auto';
      if (caps.reasoning !== 'none' && mode !== 'off' && (mode === 'on' || req.thinking?.effort)) {
        body.reasoning = { effort: threeStepEffort(req, 'high'), ...(req.thinking?.show === false ? { exclude: true } : {}) };
      }
      if (req.search?.enabled) body.plugins = [{ id: 'web', ...(req.search.maxUses ? { max_results: req.search.maxUses } : {}) }];
    },
  });
}

export const openrouterQuirks = createOpenRouterQuirks();
