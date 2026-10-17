// @ts-check
// The knowledge graph tab. Its view (graph.js: the canvas, the entity details and the new-entity
// dialog) is used nowhere else, so it loads when the tab first opens instead of with the page, and
// the service worker keeps it from then on, like the other lazy views. The tab's own buttons wait
// for it. A view that does not load (offline before it was ever cached) leaves the tab with the
// knowledge base's unreachable message, as the graph's data would; browsers keep a failed module
// import until the page reloads.
import { byId, onAction, reportUnexpected, setHidden } from './dom.js';
import { setText } from './i18n/index.js';
import { onTabOpen } from './ui.js';

/** @type {Promise<typeof import('./graph.js')> | null} */
let view = null;

/** The graph view, loaded and set up once. */
function graphView() {
  view ??= import('./graph.js').then(
    (graph) => {
      // The view writes its own status text; an earlier unreachable message must not come back
      // with a language switch.
      byId('graphStatus')?.removeAttribute('data-i18n');
      graph.initGraph();
      return graph;
    },
    (err) => {
      view = null;
      throw err;
    },
  );
  return view;
}

/** @param {unknown} err */
function unavailable(err) {
  console.warn('[starpi] the knowledge graph view did not load', err);
  setHidden(byId('graphLoading'), true);
  const status = byId('graphStatus');
  setText(status, 'data.error_unreachable');
  setHidden(status, false);
}

function refresh() {
  return graphView().then((graph) => graph.loadKnowledgeGraph(), unavailable);
}

export function initGraphTab() {
  onTabOpen('graph', () => void refresh().catch(reportUnexpected));
  onAction('reload-graph', () => refresh());
  onAction('open-entity-modal', (el) => graphView().then((graph) => graph.openEntityModal(el), unavailable));
}
