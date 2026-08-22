/* ==================== ui.js ====================
   Rendering, navigation, modals, and the object-URL lifecycle.

   Every URL handed to an <img> is tracked and revoked when the view that
   created it is torn down. Skipping that leaks each blob for the lifetime
   of the tab, which at hundreds of megabytes of images is fatal rather
   than untidy. */

/* A click event's target is decided by where the mouse button is released,
   not where it was pressed. Selecting text in a field and dragging past the
   edge of the modal card before releasing lands the mouseup on the backdrop
   — a plain 'click' listener there would read that as "click outside" and
   close the modal mid-selection. Requiring press AND release to both land
   on the backdrop itself fixes that without losing real outside-clicks. */
function onBackdropClick(modal, close) {
  let downOnBackdrop = false;
  modal.addEventListener('mousedown', e => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('mouseup', e => {
    if (downOnBackdrop && e.target === modal) close();
    downOnBackdrop = false;
  });
}

/* Replaces window.confirm/prompt with an async modal that matches the
   theme. Native confirm/prompt block the main thread synchronously, which
   can paint a stale frame behind them — a menu already told to hide could
   still show through. Being a normal async modal avoids that entirely. */
const Dialog = (() => {
  const $ = id => document.getElementById(id);
  let pending = null; // { resolve, withInput }

  function hide() {
    $('dialog-modal').classList.remove('open');
  }

  function finish(result) {
    if (!pending) return;
    const { resolve } = pending;
    pending = null;
    hide();
    resolve(result);
  }

  function show({ title, message = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false, withInput = false, placeholder = '', initialValue = '' }) {
    return new Promise(resolve => {
      pending = { resolve, withInput };

      $('dialog-title').textContent = title;
      const msgEl = $('dialog-msg');
      msgEl.textContent = message;
      msgEl.classList.toggle('hidden', !message);
      $('dialog-err').classList.add('hidden');

      const input = $('dialog-input');
      input.classList.toggle('hidden', !withInput);
      input.value = initialValue;
      input.placeholder = placeholder;

      const ok = $('dialog-ok');
      ok.textContent = okLabel;
      ok.classList.toggle('danger-cta', danger);
      $('dialog-cancel').textContent = cancelLabel;

      $('dialog-modal').classList.add('open');
      (withInput ? input : ok).focus();
      if (withInput) input.select();
    });
  }

  function submit() {
    if (!pending) return;
    if (pending.withInput) {
      const val = $('dialog-input').value.trim();
      if (!val) {
        const err = $('dialog-err');
        err.textContent = 'Give it a name.';
        err.classList.remove('hidden');
        return;
      }
      finish(val);
    } else {
      finish(true);
    }
  }

  function cancel() {
    if (!pending) return;
    finish(pending.withInput ? null : false);
  }

  const confirm = opts => show({ ...opts, withInput: false });
  const prompt = opts => show({ ...opts, withInput: true });

  function init() {
    $('dialog-form').addEventListener('submit', e => { e.preventDefault(); submit(); });
    $('dialog-cancel').addEventListener('click', cancel);
    onBackdropClick($('dialog-modal'), cancel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pending) cancel(); });
  }

  return { confirm, prompt, init };
})();

const UI = (() => {
  const state = {
    nodes: [],
    currentId: null,
    urls: [],       // object URLs owned by the current render
    editingId: null,
    noteId: null,
  };

  const $ = id => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  function trackURL(blob) {
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    return url;
  }

  function releaseURLs() {
    for (const u of state.urls) URL.revokeObjectURL(u);
    state.urls = [];
  }

  const fmtBytes = n => {
    if (n < 1024) return n + ' B';
    if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
    return (n / 1024 ** 3).toFixed(2) + ' GB';
  };

  /* ----- data ----- */

  async function reload() {
    state.nodes = await DB.allNodes();
  }

  async function commit(changed) {
    if (changed.length) await DB.putNodes(changed);
    await reload();
    render();
  }

  /* ----- rendering ----- */

  function renderCrumbs() {
    const el = $('crumbs');
    el.textContent = '';

    const chain = state.currentId ? Tree.pathTo(state.nodes, state.currentId) : [];
    const items = [{ id: null, title: 'Home' }, ...chain];

    items.forEach((node, i) => {
      const isLast = i === items.length - 1;
      const btn = document.createElement('button');
      btn.className = 'crumb' + (isLast ? ' current' : '');
      btn.textContent = node.title;
      if (!isLast) btn.addEventListener('click', () => navigate(node.id));
      DnD.attachCrumb(btn, node.id);
      el.appendChild(btn);

      if (!isLast) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        el.appendChild(sep);
      }
    });
  }

  function makeCard(node) {
    const card = document.createElement('div');
    card.className = 'card ' + node.type;
    card.dataset.id = node.id;

    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';

    if (node.type === Tree.FOLDER) {
      const icon = document.createElement('div');
      icon.className = 'folder-icon';
      icon.textContent = '📁';
      wrap.appendChild(icon);

      const n = state.nodes.filter(x => x.parentId === node.id).length;
      const count = document.createElement('span');
      count.className = 'folder-count';
      count.textContent = n === 1 ? '1 item' : n + ' items';
      wrap.appendChild(count);
    } else {
      const img = document.createElement('img');
      img.alt = node.title || '';
      img.loading = 'lazy';
      // <img> is draggable by default, which steals the drag before it
      // bubbles to the card — that's what made only the title bar
      // draggable. Turning it off lets the card's own drag handler run
      // no matter where on the thumbnail the drag starts.
      img.draggable = false;
      wrap.appendChild(img);
      // Thumbnails load per card so a large folder paints immediately.
      DB.getThumb(node.id).then(rec => {
        if (rec && rec.blob && card.isConnected) img.src = trackURL(rec.blob);
      }).catch(() => {});
    }

    const menuBtn = document.createElement('button');
    menuBtn.className = 'card-menu-btn';
    menuBtn.textContent = '⋮';
    menuBtn.setAttribute('aria-label', 'Actions');
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, node);
    });

    const body = document.createElement('div');
    body.className = 'card-body';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = node.title || 'Untitled';
    body.appendChild(title);

    if (node.type === Tree.ITEM && node.url) {
      const sub = document.createElement('div');
      sub.className = 'card-sub';
      try { sub.textContent = new URL(node.url).hostname; }
      catch (_) { sub.textContent = node.url; }
      body.appendChild(sub);
    }

    card.append(wrap, menuBtn, body);

    if (node.type === Tree.ITEM) {
      const noteBtn = document.createElement('button');
      noteBtn.className = 'note-btn' + (node.note ? ' has-note' : '');
      const noteIcon = document.createElement('img');
      noteIcon.src = 'assets/note-icon.png';
      noteIcon.alt = '';
      noteIcon.draggable = false;
      noteBtn.appendChild(noteIcon);
      // No native title attribute — that's the OS tooltip box. Hovering a
      // note that's already written shows the actual text in a themed
      // preview instead; writing still happens by clicking to open the editor.
      noteBtn.setAttribute('aria-label', node.note ? 'Edit note' : 'Add note');
      noteBtn.addEventListener('click', e => {
        e.stopPropagation();
        openNote(node);
      });
      if (node.note) {
        noteBtn.addEventListener('mouseenter', () => showNotePreview(noteBtn, node.note));
        noteBtn.addEventListener('mouseleave', scheduleHideNotePreview);
      }
      card.appendChild(noteBtn);
    }

    card.addEventListener('click', () => activate(node));
    DnD.attachCard(card, node);
    return card;
  }

  /* FLIP: measure where each card sits before the rebuild, then after
     re-appending, offset it back to its old spot with a transform and
     release the offset on the next frame — the browser animates the
     release because .card has a transform transition. A card with no
     "before" position is new, so it gets a fade-and-rise entrance instead
     of trying to fly in from nowhere. */
  function renderGrid() {
    const grid = $('grid');
    hideNotePreview(); // the hovered button is about to be replaced

    const before = new Map();
    for (const el of grid.children) {
      if (el.dataset.id) before.set(el.dataset.id, el.getBoundingClientRect());
    }

    grid.textContent = '';

    const children = Tree.childrenOf(state.nodes, state.currentId);
    const empty = $('empty');

    if (!children.length) {
      empty.classList.remove('hidden');
      empty.innerHTML = state.currentId
        ? 'This folder is empty.<br><small>Add images, or drag them in from your desktop.</small>'
        : 'Nothing here yet.<br><small>Make a folder, or drag images in from your desktop.</small>';
      return;
    }

    empty.classList.add('hidden');
    for (const node of children) grid.appendChild(makeCard(node));

    const entering = [];
    const flipping = [];
    for (const el of grid.children) {
      const prev = before.get(el.dataset.id);
      if (!prev) { entering.push(el); continue; }
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      flipping.push(el);
    }
    for (const el of entering) el.classList.add('card-enter');

    // One forced reflow commits the jumped/entering start state before the
    // release below is scheduled — without it the browser can collapse the
    // "jump then release" into a single paint and skip the animation.
    if (flipping.length || entering.length) grid.offsetHeight;

    requestAnimationFrame(() => {
      for (const el of flipping) { el.style.transition = ''; el.style.transform = ''; }
      for (const el of entering) el.classList.remove('card-enter');
    });
  }

  async function updateStatus() {
    const last = Backup.lastBackupAt();
    $('status').textContent = last ? 'Last backup ' + last.toLocaleDateString() : 'No backup yet';
    const dirty = await Backup.isDirty();
    $('backup-dot').classList.toggle('hidden', !dirty);
  }

  function render() {
    releaseURLs();
    renderCrumbs();
    renderGrid();
    updateStatus();
  }

  /* ----- navigation ----- */

  function navigate(id) {
    state.currentId = id;
    closeMenu();
    render();
  }

  function activate(node) {
    if (node.type === Tree.FOLDER) return navigate(node.id);
    // No link means clicking does nothing — opening the full-resolution
    // image was confusing when nothing was ever linked.
    if (node.url) window.open(node.url, '_blank', 'noopener');
  }

  /* ----- creating ----- */

  async function newFolder() {
    const title = await Dialog.prompt({ title: 'New folder', okLabel: 'Create', placeholder: 'Folder name' });
    if (title === null) return;

    const now = Date.now();
    const node = {
      id: uid(), type: Tree.FOLDER, parentId: state.currentId,
      title, url: '',
      order: Tree.nextOrder(state.nodes, state.currentId, Tree.FOLDER),
      createdAt: now, updatedAt: now,
    };
    await DB.putNode(node);
    await reload();
    render();
  }

  async function addFiles(files) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!list.length) return;

    let order = Tree.nextOrder(state.nodes, state.currentId, Tree.ITEM);
    for (const file of list) {
      const id = uid();
      const now = Date.now();
      let thumb;
      try {
        thumb = await Images.makeThumb(file);
      } catch (_) {
        thumb = file;
      }
      await DB.putImage(id, file, thumb, { name: file.name });
      await DB.putNode({
        id, type: Tree.ITEM, parentId: state.currentId,
        title: file.name.replace(/\.[^.]+$/, ''), url: '', note: '',
        order: order++, createdAt: now, updatedAt: now,
      });
    }
    await reload();
    render();
  }

  /* ----- moving ----- */

  async function move(dragId, parentId, beforeId) {
    const res = Tree.moveNode(state.nodes, dragId, parentId, beforeId);
    if (!res.ok) return;
    state.nodes = res.nodes;
    await commit(res.changed);
  }

  /* ----- menu ----- */

  let menuNode = null;

  function openMenu(x, y, node) {
    menuNode = node;
    const menu = $('card-menu');
    menu.classList.remove('hidden');
    // Clamp so the menu never opens off-screen near the right or bottom edge.
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  }

  function closeMenu() {
    $('card-menu').classList.add('hidden');
    menuNode = null;
  }

  async function removeNode(node) {
    const kids = Tree.descendantsOf(state.nodes, node.id);
    // Naming the real count matters: with nesting you can be one click from
    // destroying far more than you're picturing.
    const title = node.type === Tree.FOLDER && kids.length
      ? `Delete "${node.title}" and the ${kids.length} item${kids.length === 1 ? '' : 's'} inside it?`
      : `Delete "${node.title}"?`;
    const ok = await Dialog.confirm({ title, message: 'This cannot be undone.', okLabel: 'Delete', danger: true });
    if (!ok) return;

    await DB.deleteNodes([node.id, ...kids]);
    await reload();
    render();
  }

  /* ----- edit modal ----- */

  function openEdit(node) {
    state.editingId = node.id;
    $('edit-title').textContent = node.type === Tree.FOLDER ? 'Rename folder' : 'Edit image';
    $('edit-name').value = node.title || '';
    $('edit-url').value = node.url || '';
    $('edit-url').classList.toggle('hidden', node.type === Tree.FOLDER);
    $('edit-err').classList.add('hidden');

    const preview = $('edit-preview');
    preview.classList.add('hidden');
    preview.removeAttribute('src');
    if (node.type === Tree.ITEM) {
      DB.getThumb(node.id).then(rec => {
        if (rec && rec.blob) {
          preview.src = trackURL(rec.blob);
          preview.classList.remove('hidden');
        }
      }).catch(() => {});
    }

    $('edit-modal').classList.add('open');
    $('edit-name').focus();
  }

  async function saveEdit(e) {
    e.preventDefault();
    const node = Tree.byId(state.nodes, state.editingId);
    if (!node) return;

    const title = $('edit-name').value.trim();
    if (!title) {
      $('edit-err').textContent = 'Give it a name.';
      $('edit-err').classList.remove('hidden');
      return;
    }

    let url = $('edit-url').value.trim();
    if (url && node.type === Tree.ITEM) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      try { new URL(url); }
      catch (_) {
        $('edit-err').textContent = "That link doesn't look like a web address.";
        $('edit-err').classList.remove('hidden');
        return;
      }
    }

    await DB.putNode({ ...node, title, url: node.type === Tree.FOLDER ? '' : url, updatedAt: Date.now() });
    $('edit-modal').classList.remove('open');
    await reload();
    render();
  }

  /* ----- note preview -----
     Fixed-position like #card-menu, rather than nested inside the card —
     the card clips overflow, so a tooltip anchored inside it would get cut
     off for anything longer than a couple of words.

     There's a real gap between the button and the panel below it, so a
     bare mouseleave-hides-it wiring means the preview vanishes the instant
     the pointer starts moving toward it — the panel is never reachable.
     A short grace-period timer bridges that gap: leaving either the button
     or the panel schedules a hide, but re-entering either one cancels it. */

  let notePreviewHideTimer = null;

  function cancelNotePreviewHide() {
    if (notePreviewHideTimer) { clearTimeout(notePreviewHideTimer); notePreviewHideTimer = null; }
  }

  function showNotePreview(btn, text) {
    cancelNotePreviewHide();
    const el = $('note-preview');
    el.textContent = text;
    el.classList.remove('hidden');
    const anchor = btn.getBoundingClientRect();
    const size = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - size.width - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 8, innerHeight - size.height - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function hideNotePreview() {
    cancelNotePreviewHide();
    $('note-preview').classList.add('hidden');
  }

  function scheduleHideNotePreview() {
    cancelNotePreviewHide();
    notePreviewHideTimer = setTimeout(hideNotePreview, 200);
  }

  /* ----- note modal -----
     A dedicated one-click editor for jotting down what a saved site is,
     separate from the full edit modal — the whole point is to be faster to
     reach than opening the ⋮ menu. */

  function openNote(node) {
    state.noteId = node.id;
    $('note-title').textContent = 'Note — ' + (node.title || 'Untitled');
    $('note-text').value = node.note || '';
    $('note-modal').classList.add('open');
    $('note-text').focus();
  }

  async function saveNote(e) {
    e.preventDefault();
    const node = Tree.byId(state.nodes, state.noteId);
    if (!node) return;
    const note = $('note-text').value.trim();
    await DB.putNode({ ...node, note, updatedAt: Date.now() });
    $('note-modal').classList.remove('open');
    await reload();
    render();
  }

  /* ----- backup modal ----- */

  function bkMsg(text, kind) {
    const el = $('bk-msg');
    el.textContent = text;
    el.className = 'msg ' + (kind || '');
    el.classList.toggle('hidden', !text);
  }

  async function openBackup() {
    bkMsg('');
    $('bk-note').textContent = '';
    const last = Backup.lastBackupAt();
    const dirty = await Backup.isDirty();
    $('bk-status').textContent = last
      ? 'Last backup: ' + last.toLocaleString() + (dirty ? ' — changed since then.' : ' — up to date.')
      : 'No backup yet.';

    // Tell them which format they'll get before they click, so a sudden .zip
    // isn't a surprise.
    try {
      const bytes = await DB.totalBlobBytes();
      $('bk-note').textContent = bytes > Backup.THRESHOLD
        ? `${fmtBytes(bytes)} of images — you'll get a .zip.`
        : `${fmtBytes(bytes)} of images — you'll get a single .json file.`;
    } catch (_) {}

    $('backup-modal').classList.add('open');
  }

  async function doExport() {
    const btn = $('bk-export');
    btn.disabled = true;
    try {
      const res = await Backup.exportAll(t => bkMsg(t, ''));
      bkMsg(`Saved ${res.filename} (${fmtBytes(res.bytes)}). Keep it somewhere safe.`, 'ok');
      updateStatus();
    } catch (err) {
      bkMsg(err.message || 'Export failed.', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function doRestore(file) {
    if (!file) return;
    try {
      // Parse before confirming, so the prompt can name the backup's real
      // date and a bad file is rejected without ever threatening the data.
      bkMsg('Reading backup…', '');
      const { meta } = await Backup.parse(file);
      const when = new Date(meta.savedAt).toLocaleString();
      const count = meta.nodes.length;
      const ok = await Dialog.confirm({
        title: `Restore the backup from ${when}?`,
        message: `It holds ${count} item${count === 1 ? '' : 's'}. Everything currently in this browser will be replaced.`,
        okLabel: 'Restore',
        danger: true,
      });
      if (!ok) { bkMsg(''); return; }

      const res = await Backup.restore(file, t => bkMsg(t, ''));
      state.currentId = null;
      await reload();
      render();
      bkMsg(`Restored ${res.nodes} item${res.nodes === 1 ? '' : 's'} and ${res.images} image${res.images === 1 ? '' : 's'}.`, 'ok');
    } catch (err) {
      bkMsg(err.message || 'Restore failed.', 'err');
    } finally {
      $('bk-file').value = '';
    }
  }

  /* ----- wiring ----- */

  function init() {
    Dialog.init();
    DnD.init({
      getNodes: () => state.nodes,
      move,
      addFiles,
    });

    // Moving from the button onto the panel crosses a real gap — these
    // keep it open through that gap the same way the button's own
    // mouseenter does, rather than just tearing it down.
    $('note-preview').addEventListener('mouseenter', cancelNotePreviewHide);
    $('note-preview').addEventListener('mouseleave', scheduleHideNotePreview);

    $('new-folder-btn').addEventListener('click', newFolder);
    $('add-images-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', e => {
      addFiles(e.target.files);
      e.target.value = '';
    });

    $('backup-btn').addEventListener('click', openBackup);
    $('bk-export').addEventListener('click', doExport);
    $('bk-file').addEventListener('change', e => doRestore(e.target.files[0]));

    $('edit-form').addEventListener('submit', saveEdit);
    $('note-form').addEventListener('submit', saveNote);

    $('card-menu').addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (!act || !menuNode) return;
      const node = menuNode;
      closeMenu();
      if (act === 'open') activate(node);
      if (act === 'edit') openEdit(node);
      if (act === 'delete') removeNode(node);
    });

    document.addEventListener('click', e => {
      if (!$('card-menu').contains(e.target)) closeMenu();
    });

    // #dialog-modal is excluded from all three: it resolves a pending
    // promise on close (see Dialog.init below), so it needs Dialog.cancel()
    // rather than having its 'open' class blindly stripped.
    for (const el of document.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => el.closest('.modal').classList.remove('open'));
    }
    for (const modal of document.querySelectorAll('.modal:not(#dialog-modal)')) {
      onBackdropClick(modal, () => modal.classList.remove('open'));
    }
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      closeMenu();
      for (const m of document.querySelectorAll('.modal.open:not(#dialog-modal)')) m.classList.remove('open');
    });

    /* No dragover handler on the grid itself. An earlier version called
       preventDefault there to catch background drops, but dragover bubbles
       up from the cards — so it also accepted drags the card had already
       refused, showing a drop cursor over illegal targets like a folder
       held over an image. External file drags are covered by the
       document-level handlers in dnd.js, so this needs nothing. */

    reload().then(render).catch(err => {
      $('empty').classList.remove('hidden');
      $('empty').textContent = 'Could not open storage: ' + err.message;
    });
  }

  return { init, state, render, reload };
})();

document.addEventListener('DOMContentLoaded', UI.init);
