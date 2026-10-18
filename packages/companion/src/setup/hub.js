// @ts-check
// The hub: how the standard modules find each other's services without the kernel knowing them.
// The kernel gives every module only what it declared (its vault namespaces, its audit prefix);
// what one module offers another (the search index, the notes, the inbox) is published here under
// a fixed name when the module starts and withdrawn when it stops. A lookup is made at the moment
// of use and may find nothing: a module that is not loaded is simply absent, and the caller goes on
// without it.

/**
 * The services the standard modules publish, by name.
 * @typedef {object} HubServices
 * @property {import('../retrieval/index.js').Retrieval} retrieval
 * @property {import('../memory/module.js').MemoryService} memory
 * @property {import('../docs/module.js').DocumentsService} documents
 * @property {import('../notify/inbox.js').Inbox} notify
 * @property {import('../agenda/module.js').AgendaService} agenda
 * @property {import('../feeds/module.js').FeedsService} feeds
 * @property {import('../connectors/module.js').ToolsService} tools
 */

/** @typedef {keyof HubServices} HubName */

export function createHub() {
  /** @type {Map<string, unknown>} */
  const services = new Map();
  return {
    /**
     * Publishes a service; returns the function that withdraws it again.
     * @template {HubName} K
     * @param {K} name
     * @param {HubServices[K]} service
     * @returns {() => void}
     */
    provide(name, service) {
      if (services.has(name)) throw new TypeError(`the hub holds a ${name} service already`);
      services.set(name, service);
      return () => {
        if (services.get(name) === service) services.delete(name);
      };
    },
    /**
     * The service of that name, or null while no module offers it.
     * @template {HubName} K
     * @param {K} name
     * @returns {HubServices[K] | null}
     */
    get(name) {
      return /** @type {HubServices[K] | undefined} */ (services.get(name)) ?? null;
    },
    /** Names of the services published now. */
    names: () => [...services.keys()].sort(),
  };
}

/** @typedef {ReturnType<typeof createHub>} Hub */
