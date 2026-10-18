// @ts-check
// Tools: the built-in tools, the web search service, MCP servers and image making of the free chat
// (chat/tools.js), with their card under Settings (ai/mcp/view.js). Both load as their own chunk
// after the first paint; the composer's tools menu fills once they are in.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'tools',
  async mount(el, ctx) {
    const [{ installChatTools, searchWithSettings }, { mountToolsView }, { keyStore }] = await Promise.all([import('../chat/tools.js'), import('../ai/mcp/view.js'), import('../ai/keys.js')]);
    const runtime = installChatTools({
      openSettings: () => {
        ctx.switchTab('settings');
        requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      },
    });
    mountToolsView(el, ctx, { runtime, keys: keyStore, testSearch: searchWithSettings });
  },
};

registerFeature('toolSettings', feature);
