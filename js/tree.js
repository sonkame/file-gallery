/* ==================== tree.js ====================
   Pure tree logic: ordering, move validation, recursive descent.

   Everything here operates on plain arrays of node records and returns
   new data. No IndexedDB, no DOM. That's what makes it testable in
   isolation, and it's where the rules that protect the tree live. */

const Tree = (() => {
  const FOLDER = 'folder';
  const ITEM = 'item';

  /* Folders always sort above items, then by `order` within their group.
     Deriving "folders first" from the type at sort time — rather than
     maintaining it as a position — means it cannot drift out of sync. */
  function sortKey(node) {
    return node.type === FOLDER ? 0 : 1;
  }

  function sortNodes(nodes) {
    return nodes.slice().sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return a.order - b.order;
    });
  }

  function childrenOf(nodes, parentId) {
    return sortNodes(nodes.filter(n => n.parentId === parentId));
  }

  /* Orders are tracked per (parent, type) group. Because sorting breaks ties
     on type first, a folder and an item may share an order value without
     ambiguity, so the two groups renumber independently. */
  function siblingGroup(nodes, parentId, type) {
    return sortNodes(nodes.filter(n => n.parentId === parentId && n.type === type));
  }

  function byId(nodes, id) {
    return nodes.find(n => n.id === id) || null;
  }

  /* Walks up from `id` looking for `ancestorId`. Used to reject moving a
     folder into its own subtree, which would detach that subtree from the
     root — the nodes would still exist but become unreachable forever. */
  function isDescendantOf(nodes, id, ancestorId) {
    let cur = byId(nodes, id);
    const seen = new Set();
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) return false; // corrupt data; fail closed
      seen.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = byId(nodes, cur.parentId);
    }
    return false;
  }

  /* Every id beneath `id`, depth first. Drives recursive delete. */
  function descendantsOf(nodes, id) {
    const out = [];
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      for (const n of nodes) {
        if (n.parentId === cur && !seen.has(n.id)) {
          seen.add(n.id);
          out.push(n.id);
          stack.push(n.id);
        }
      }
    }
    return out;
  }

  /* Breadcrumb chain from root down to (and including) `id`. */
  function pathTo(nodes, id) {
    const out = [];
    let cur = byId(nodes, id);
    const seen = new Set();
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId === null ? null : byId(nodes, cur.parentId);
    }
    return out;
  }

  /* The single authority on whether a drag is legal. The UI asks this before
     showing any drop affordance, so a rejected move is felt as "no drop
     indicator" rather than reported as an error after the fact. */
  function canMove(nodes, dragId, newParentId) {
    const drag = byId(nodes, dragId);
    if (!drag) return false;
    if (dragId === newParentId) return false;

    if (newParentId !== null) {
      const target = byId(nodes, newParentId);
      if (!target) return false;
      if (target.type !== FOLDER) return false; // nothing nests inside an item
      if (drag.type === FOLDER && isDescendantOf(nodes, newParentId, dragId)) return false;
    }
    return true;
  }

  function renumber(group) {
    return group.map((n, i) => (n.order === i ? n : { ...n, order: i }));
  }

  /* Moves `dragId` under `newParentId`, positioned before `beforeId`
     (or last when beforeId is null). Returns the full updated node list
     plus just the records that changed, so callers write the minimum. */
  function moveNode(nodes, dragId, newParentId, beforeId = null) {
    if (!canMove(nodes, dragId, newParentId)) {
      return { nodes, changed: [], ok: false };
    }

    const drag = byId(nodes, dragId);
    const oldParentId = drag.parentId;
    const moved = { ...drag, parentId: newParentId, updatedAt: Date.now() };

    const rest = nodes.filter(n => n.id !== dragId);

    // Position within the destination group of the same type.
    const dest = siblingGroup(rest, newParentId, drag.type);
    let insertAt = dest.length;
    if (beforeId !== null) {
      const idx = dest.findIndex(n => n.id === beforeId);
      if (idx !== -1) insertAt = idx;
    }
    dest.splice(insertAt, 0, moved);

    const updates = new Map();
    for (const n of renumber(dest)) updates.set(n.id, n);

    // The vacated group closes its gap so orders stay dense.
    if (oldParentId !== newParentId) {
      const src = siblingGroup(rest, oldParentId, drag.type);
      for (const n of renumber(src)) updates.set(n.id, n);
    }

    const next = nodes.map(n => updates.get(n.id) || n);
    for (const n of updates.values()) {
      if (!next.some(x => x.id === n.id)) next.push(n);
    }

    const changed = [];
    for (const n of next) {
      const before = byId(nodes, n.id);
      if (!before || before.order !== n.order || before.parentId !== n.parentId) changed.push(n);
    }

    return { nodes: next, changed, ok: true };
  }

  /* Order for a freshly created node: last within its own type group. */
  function nextOrder(nodes, parentId, type) {
    const group = siblingGroup(nodes, parentId, type);
    return group.length ? group[group.length - 1].order + 1 : 0;
  }

  return {
    FOLDER, ITEM,
    sortNodes, childrenOf, siblingGroup, byId,
    isDescendantOf, descendantsOf, pathTo,
    canMove, moveNode, renumber, nextOrder,
  };
})();

if (typeof module !== 'undefined') module.exports = Tree;
