// @ts-check
// The standard modules of the companion, in their start order, sharing one hub. The command line
// starts all of them; an embedding program may pick its own list. A module that has nothing
// configured stays quiet (no feeds, no connectors, no voice server), so the full list is safe to
// start on any machine.
import { createAgendaModule } from '../agenda/module.js';
import { createAskModule, createChatModule } from '../chat/module.js';
import { createConnectorsModule } from '../connectors/module.js';
import { createDocsModule } from '../docs/module.js';
import { createFeedsModule } from '../feeds/module.js';
import { createMcpModule } from '../mcp/module.js';
import { createMemoryModule } from '../memory/module.js';
import { createNotifyModule } from '../notify/module.js';
import { createRetrievalModule } from '../retrieval/module.js';
import { createHub } from './hub.js';

/** Ids of the standard modules, in start order. */
export const STANDARD_MODULE_IDS = Object.freeze(['retrieval', 'notify', 'memory', 'docs', 'feeds', 'agenda', 'connectors', 'ask', 'chat', 'mcp']);

/**
 * @param {{ hub?: import('./hub.js').Hub, only?: readonly string[], fetchImpl?: typeof fetch }} [options]
 *   only: start just these ids (in standard order); fetchImpl: the fetch of local HTTP clients (tests)
 * @returns {import('../contracts/module.js').CompanionModule[]}
 */
export function standardModules({ hub = createHub(), only, fetchImpl } = {}) {
  /** @type {Record<string, () => import('../contracts/module.js').CompanionModule>} */
  const factories = {
    retrieval: () => createRetrievalModule({ hub, fetchImpl }),
    notify: () => createNotifyModule({ hub }),
    memory: () => createMemoryModule({ hub }),
    docs: () => createDocsModule({ hub }),
    feeds: () => createFeedsModule({ hub }),
    agenda: () => createAgendaModule({ hub }),
    connectors: () => createConnectorsModule({ hub }),
    ask: () => createAskModule({ hub }),
    chat: () => createChatModule({ hub }),
    mcp: () => createMcpModule({ hub }),
  };
  const wanted = only ?? STANDARD_MODULE_IDS;
  for (const id of wanted) if (!Object.hasOwn(factories, id)) throw new TypeError(`no standard module ${id}`);
  return STANDARD_MODULE_IDS.filter((id) => wanted.includes(id)).map((id) => factories[id]());
}
