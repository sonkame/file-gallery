/* ==================== dnd.js ====================
   Drag and drop wiring. Two distinct kinds of drag are handled here:

     internal  moving a folder or image within the gallery
     external  files dragged in from the desktop

   Tree.canMove is the sole authority on whether an internal drop is legal;
   this module never re-implements the rules, it only asks. A rejected
   target simply renders no affordance, so an illegal move is felt as the
   absence of a drop line rather than reported as an error afterwards. */

const DnD = (() => {
  let ctx = null;
  let dragId = null;
  let marked = [];

  const clearMarks = () => {
    for (const el of marked) el.classList.remove('drop-into', 'drop-before', 'drop-after');
    marked = [];
  };

  const mark = (el, cls) => { el.classList.add(cls); marked.push(el); };

  /* Where a drop would land, given what's being dragged and where the
     pointer sits over the target. Returns null when the target is illegal.

     Folders sort above items unconditionally, so reordering across the two
     groups is meaningless — an item over a folder can only mean "put it
     inside", and a folder over an item means nothing at all. */
  function intent(nodes, drag, target, rect, x) {
    if (!drag || !target || drag.id === target.id) return null;
    const targetIsFolder = target.type === Tree.FOLDER;

    if (drag.type === Tree.ITEM) {
      if (targetIsFolder) return { kind: 'into', id: target.id };
      const before = x < rect.left + rect.width / 2;
      return { kind: before ? 'before' : 'after', id: target.id };
    }

    // Dragging a folder.
    if (!targetIsFolder) return null;
    const rel = (x - rect.left) / rect.width;
    if (rel > 0.28 && rel < 0.72) return { kind: 'into', id: target.id };
    return { kind: rel <= 0.28 ? 'before' : 'after', id: target.id };
  }

  /* Turns an intent into the (parentId, beforeId) pair moveNode expects,
     or null when Tree rejects it. */
  function resolve(nodes, drag, it) {
    if (!it) return null;

    if (it.kind === 'into') {
      return Tree.canMove(nodes, drag.id, it.id) ? { parentId: it.id, beforeId: null } : null;
    }

    const target = Tree.byId(nodes, it.id);
    if (!target) return null;
    const parentId = target.parentId;
    if (!Tree.canMove(nodes, drag.id, parentId)) return null;

    let beforeId = target.id;
    if (it.kind === 'after') {
      const group = Tree.siblingGroup(nodes, parentId, drag.type);
      const idx = group.findIndex(n => n.id === target.id);
      beforeId = idx === -1 || idx + 1 >= group.length ? null : group[idx + 1].id;
    }
    return { parentId, beforeId };
  }

  /* ----- card wiring ----- */

  function attachCard(el, node) {
    el.draggable = true;

    el.addEventListener('dragstart', e => {
      dragId = node.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox ignores a drag that sets no data.
      e.dataTransfer.setData('text/plain', node.id);
    });

    el.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('dragging');
      clearMarks();
    });

    el.addEventListener('dragover', e => {
      if (!dragId) return; // external file drag; the pane handles it
      const nodes = ctx.getNodes();
      const drag = Tree.byId(nodes, dragId);
      const it = intent(nodes, drag, node, el.getBoundingClientRect(), e.clientX);
      const target = resolve(nodes, drag, it);
      clearMarks();
      if (!target) return; // illegal: no preventDefault, no affordance, no drop
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(el, it.kind === 'into' ? 'drop-into' : it.kind === 'before' ? 'drop-before' : 'drop-after');
    });

    el.addEventListener('dragleave', () => clearMarks());

    el.addEventListener('drop', e => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      const nodes = ctx.getNodes();
      const drag = Tree.byId(nodes, dragId);
      const it = intent(nodes, drag, node, el.getBoundingClientRect(), e.clientX);
      const target = resolve(nodes, drag, it);
      clearMarks();
      if (target) ctx.move(dragId, target.parentId, target.beforeId);
      dragId = null;
    });
  }

  /* Breadcrumbs accept drops so something buried several levels deep can be
     lifted out in one motion instead of navigated back up. */
  function attachCrumb(el, folderId) {
    el.addEventListener('dragover', e => {
      if (!dragId) return;
      if (!Tree.canMove(ctx.getNodes(), dragId, folderId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearMarks();
      mark(el, 'drop-into');
    });
    el.addEventListener('dragleave', () => clearMarks());
    el.addEventListener('drop', e => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      if (Tree.canMove(ctx.getNodes(), dragId, folderId)) ctx.move(dragId, folderId, null);
      dragId = null;
    });
  }

  /* ----- external files ----- */

  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function initFileDrop() {
    let depth = 0;
    const pane = document.getElementById('droppane');

    document.addEventListener('dragenter', e => {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('filedrag');
    });

    document.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      // dragleave fires for every child element, so only a balanced count
      // means the pointer actually left the window.
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('filedrag');
    });

    document.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      pane.classList.toggle('hot', pane.contains(e.target) || e.target === pane);
    });

    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('filedrag');
      pane.classList.remove('hot');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length) ctx.addFiles(files);
    });
  }

  function init(context) {
    ctx = context;
    initFileDrop();
  }

  return { init, attachCard, attachCrumb, intent, resolve };
})();

if (typeof module !== 'undefined') module.exports = DnD;
