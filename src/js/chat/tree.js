// @ts-check
// The message tree of one conversation, as pure functions over its node records. Every node points
// to its parent; editing or regenerating adds a sibling, so a conversation is a tree whose shown
// thread is the path from the root to one leaf (the conversation's activeLeafId).
//
//   const tree = indexNodes(nodes);
//   const path = activePath(tree, conversation.activeLeafId);     // the thread to show and to replay
//   const nav = branchInfo(tree, path[i].id);                     // { position: 2, count: 3 } -> ‹ 2/3 ›
//   const leaf = switchBranch(tree, path[i].id, +1);              // the leaf to make active next
//
// Siblings are ordered by creation time, then by id, so every caller sees the same order.

/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */

/**
 * @typedef {object} NodeTree
 * @property {Map<string, NodeRecord>} byId
 * @property {Map<string | null, NodeRecord[]>} children  child lists by parent id (null: the roots), in sibling order
 */

/**
 * @typedef {object} BranchInfo
 * @property {number} position  1-based place among the siblings
 * @property {number} count  number of siblings including the node itself
 * @property {string | null} previous  id of the sibling before, if any
 * @property {string | null} next  id of the sibling after, if any
 */

/**
 * @param {NodeRecord} a
 * @param {NodeRecord} b
 */
function siblingOrder(a, b) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Indexes the nodes of one conversation. A node whose parent is missing is treated as a root, so a
 * partly damaged tree still shows every message.
 * @param {readonly NodeRecord[]} nodes
 * @returns {NodeTree}
 */
export function indexNodes(nodes) {
  /** @type {Map<string, NodeRecord>} */
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node);
  /** @type {Map<string | null, NodeRecord[]>} */
  const children = new Map();
  for (const node of byId.values()) {
    const parent = node.parentId !== null && byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  for (const list of children.values()) list.sort(siblingOrder);
  return { byId, children };
}

/**
 * @param {NodeTree} tree
 * @param {NodeRecord} node
 * @returns {string | null} the parent id as the tree sees it (null for a root or an orphan)
 */
function parentOf(tree, node) {
  return node.parentId !== null && tree.byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
}

/**
 * @param {NodeTree} tree
 * @param {string | null} parentId
 * @returns {NodeRecord[]} the children of a node (or the roots), in sibling order
 */
export function childrenOf(tree, parentId) {
  return tree.children.get(parentId) ?? [];
}

/**
 * The path from the root to a node, root first. Stops at a cycle instead of looping.
 * @param {NodeTree} tree
 * @param {string | null | undefined} nodeId
 * @returns {NodeRecord[]} empty when the node is unknown
 */
export function pathTo(tree, nodeId) {
  /** @type {NodeRecord[]} */
  const path = [];
  const seen = new Set();
  let node = nodeId ? tree.byId.get(nodeId) : undefined;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.push(node);
    const parent = parentOf(tree, node);
    node = parent ? tree.byId.get(parent) : undefined;
  }
  return path.reverse();
}

/**
 * Follows the newest child from a node down to a leaf: where a branch continues when it is chosen.
 * @param {NodeTree} tree
 * @param {string} nodeId
 * @returns {string} the leaf id (the node itself when it has no children)
 */
export function newestLeaf(tree, nodeId) {
  let id = nodeId;
  const seen = new Set([id]);
  for (;;) {
    const kids = childrenOf(tree, id);
    const last = kids[kids.length - 1];
    if (!last || seen.has(last.id)) return id;
    seen.add(last.id);
    id = last.id;
  }
}

/**
 * The newest leaf of the whole conversation: the end of the most recent root's newest branch.
 * @param {NodeTree} tree
 * @returns {string | null}
 */
export function latestLeaf(tree) {
  const roots = childrenOf(tree, null);
  const root = roots[roots.length - 1];
  return root ? newestLeaf(tree, root.id) : null;
}

/**
 * The thread to show: the path to the active leaf. A missing or unknown leaf falls back to the
 * newest leaf, so a conversation never shows up empty while it has messages.
 * @param {NodeTree} tree
 * @param {string | null | undefined} activeLeafId
 * @returns {NodeRecord[]}
 */
export function activePath(tree, activeLeafId) {
  const path = pathTo(tree, activeLeafId);
  return path.length > 0 ? path : pathTo(tree, latestLeaf(tree));
}

/**
 * The siblings of a node (the node included), in sibling order.
 * @param {NodeTree} tree
 * @param {string} nodeId
 * @returns {NodeRecord[]}
 */
export function siblingsOf(tree, nodeId) {
  const node = tree.byId.get(nodeId);
  return node ? childrenOf(tree, parentOf(tree, node)) : [];
}

/**
 * Where a node stands among its siblings, for a `‹ 2/3 ›` navigator.
 * @param {NodeTree} tree
 * @param {string} nodeId
 * @returns {BranchInfo}
 */
export function branchInfo(tree, nodeId) {
  const siblings = siblingsOf(tree, nodeId);
  const at = siblings.findIndex((n) => n.id === nodeId);
  if (at === -1) return { position: 0, count: 0, previous: null, next: null };
  return { position: at + 1, count: siblings.length, previous: siblings[at - 1]?.id ?? null, next: siblings[at + 1]?.id ?? null };
}

/**
 * The leaf to activate when the user steps from a node to a sibling branch (delta -1: ‹, +1: ›).
 * The chosen sibling continues on its newest branch.
 * @param {NodeTree} tree
 * @param {string} nodeId
 * @param {number} delta
 * @returns {string | null} null when there is no sibling in that direction
 */
export function switchBranch(tree, nodeId, delta) {
  const siblings = siblingsOf(tree, nodeId);
  const at = siblings.findIndex((n) => n.id === nodeId);
  const target = at === -1 ? undefined : siblings[at + Math.trunc(delta)];
  return target && delta !== 0 ? newestLeaf(tree, target.id) : null;
}

/**
 * Every leaf of the tree, oldest branch first.
 * @param {NodeTree} tree
 * @returns {string[]}
 */
export function leaves(tree) {
  /** @type {NodeRecord[]} */
  const out = [];
  for (const node of tree.byId.values()) if (childrenOf(tree, node.id).length === 0) out.push(node);
  return out.sort(siblingOrder).map((n) => n.id);
}

/**
 * The text of a message: its text parts, in order. Other parts (images, files, tool calls, provider
 * state) are not text.
 * @param {{ parts: ReadonlyArray<{ type: string } & Record<string, unknown>> }} node
 * @returns {string}
 */
export function nodeText(node) {
  return (node.parts ?? [])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => String(p.text))
    .join('\n\n');
}
