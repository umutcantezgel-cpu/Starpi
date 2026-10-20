// The message tree as pure functions: the path to a leaf, sibling order, the ‹ n/m › navigator,
// stepping between branches, the fallback when the active leaf is gone, and damaged trees (orphans,
// cycles) that still show every message.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activePath, branchInfo, childrenOf, indexNodes, latestLeaf, leaves, newestLeaf, nodeText, pathTo, siblingsOf, switchBranch } from '../../src/js/chat/tree.js';

/** @typedef {import('../../src/js/store/schema.js').NodeRecord} NodeRecord */

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {number} createdAt
 * @param {'user' | 'assistant'} [role]
 * @returns {NodeRecord}
 */
function node(id, parentId, createdAt, role = parentId === null || id.startsWith('q') ? 'user' : 'assistant') {
  return { id, conversationId: 'c1', parentId, role, parts: [{ type: 'text', text: id }], opaque: [], model: null, provider: null, label: null, usage: null, localOnly: false, createdAt };
}

// q1 ─ a1 ─ q2 ─ a2
//    │         └ a2b (regenerated)
//    └ a1b ─ q3        (regenerated first answer, continued)
// q1b (edited first question)
const NODES = [
  node('q1', null, 1),
  node('a1', 'q1', 2),
  node('q2', 'a1', 3),
  node('a2', 'q2', 4),
  node('a1b', 'q1', 5),
  node('q3', 'a1b', 6),
  node('a2b', 'q2', 7),
  node('q1b', null, 8),
];

describe('chat tree', () => {
  const tree = indexNodes([...NODES].reverse());

  it('orders siblings by creation time, then by id', () => {
    assert.deepEqual(childrenOf(tree, null).map((n) => n.id), ['q1', 'q1b']);
    assert.deepEqual(childrenOf(tree, 'q1').map((n) => n.id), ['a1', 'a1b']);
    assert.deepEqual(childrenOf(tree, 'q2').map((n) => n.id), ['a2', 'a2b']);
    const tied = indexNodes([node('b', 'r', 5), node('a', 'r', 5), node('r', null, 1)]);
    assert.deepEqual(childrenOf(tied, 'r').map((n) => n.id), ['a', 'b']);
  });

  it('builds the path from the root to a node', () => {
    assert.deepEqual(pathTo(tree, 'a2b').map((n) => n.id), ['q1', 'a1', 'q2', 'a2b']);
    assert.deepEqual(pathTo(tree, 'q3').map((n) => n.id), ['q1', 'a1b', 'q3']);
    assert.deepEqual(pathTo(tree, 'missing'), []);
    assert.deepEqual(pathTo(tree, null), []);
  });

  it('shows the active leaf, or the newest leaf when the active one is unknown', () => {
    assert.deepEqual(activePath(tree, 'a2').map((n) => n.id), ['q1', 'a1', 'q2', 'a2']);
    assert.equal(latestLeaf(tree), 'q1b');
    assert.deepEqual(activePath(tree, 'gone').map((n) => n.id), ['q1b']);
    assert.deepEqual(activePath(indexNodes([]), null), []);
  });

  it('tells where a node stands among its siblings', () => {
    assert.deepEqual(branchInfo(tree, 'a1'), { position: 1, count: 2, previous: null, next: 'a1b' });
    assert.deepEqual(branchInfo(tree, 'a2b'), { position: 2, count: 2, previous: 'a2', next: null });
    assert.deepEqual(branchInfo(tree, 'q2'), { position: 1, count: 1, previous: null, next: null });
    assert.deepEqual(branchInfo(tree, 'q1b'), { position: 2, count: 2, previous: 'q1', next: null });
    assert.deepEqual(branchInfo(tree, 'nope'), { position: 0, count: 0, previous: null, next: null });
    assert.deepEqual(siblingsOf(tree, 'a1b').map((n) => n.id), ['a1', 'a1b']);
  });

  it('steps to a sibling branch and continues on its newest leaf', () => {
    assert.equal(switchBranch(tree, 'a1', 1), 'q3');
    assert.equal(switchBranch(tree, 'a1b', -1), 'a2b');
    assert.equal(switchBranch(tree, 'a1', -1), null);
    assert.equal(switchBranch(tree, 'a1b', 1), null);
    assert.equal(switchBranch(tree, 'a1', 0), null);
    assert.equal(newestLeaf(tree, 'q2'), 'a2b');
    assert.equal(newestLeaf(tree, 'a2'), 'a2');
  });

  it('lists every leaf, oldest first', () => {
    assert.deepEqual(leaves(tree), ['a2', 'q3', 'a2b', 'q1b']);
  });

  it('treats orphans as roots and stops at cycles', () => {
    const damaged = indexNodes([node('x', 'lost', 1), node('y', 'z', 2), node('z', 'y', 3), node('self', 'self', 4)]);
    assert.deepEqual(childrenOf(damaged, null).map((n) => n.id), ['x', 'self']);
    assert.deepEqual(pathTo(damaged, 'y').map((n) => n.id), ['z', 'y']);
    assert.equal(newestLeaf(damaged, 'y'), 'z');
    assert.deepEqual(pathTo(damaged, 'self').map((n) => n.id), ['self']);
  });

  it('reads the text parts of a message only', () => {
    const msg = { parts: [{ type: 'text', text: 'Look at this' }, { type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'opaque', block: {} }, { type: 'text', text: 'and this.' }] };
    assert.equal(nodeText(msg), 'Look at this\n\nand this.');
    assert.equal(nodeText({ parts: [] }), '');
  });
});
