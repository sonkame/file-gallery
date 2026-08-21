/* ==================== ui.js ====================
   Rendering, navigation, modals, and the object-URL lifecycle.

   Every URL handed to an <img> is tracked and revoked when the view that
   created it is torn down. Skipping that leaks each blob for the lifetime
   of the tab, which at hundreds of megabytes of images is fatal rather
   than untidy. */

const UI = (() => {
  const state = {
    nodes: [],
    currentId: null,
    urls: [],       // object URLs owned by the current render
    editingId: null,
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
    card.addEventListener('click', () => activate(node));
    DnD.attachCard(card, node);
    return card;
  }

  function renderGrid() {
    const grid = $('grid');
    grid.textContent = '';

    const children = Tree.childrenOf(state.nodes, state.currentId);
    const empty = $('empty');

    if (!children.length) {
      empty.classList.remove('hidden');
      empty.innerHTML = state.currentId
        ? 'This folder is empty.<br><small>Add images, or drag them in from your desktop.</small>'
        : 'Nothing here yet.<br><small>Make a folder, or drag images in from your desktop.</small>';
    } else {
      empty.classList.add('hidden');
      for (const node of children) grid.appendChild(makeCard(node));
    }
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

  async function activate(node) {
    if (node.type === Tree.FOLDER) return navigate(node.id);
    if (node.url) return window.open(node.url, '_blank', 'noopener');
    // No link: fall back to the full-resolution image, which is the only
    // other thing "open" could sensibly mean for an item.
    const rec = await DB.getBlob(node.id);
    if (rec && rec.blob) window.open(URL.createObjectURL(rec.blob), '_blank', 'noopener');
  }

  /* ----- creating ----- */

  async function newFolder() {
    const name = prompt('Folder name');
    if (name === null) return;
    const title = name.trim();
    if (!title) return;

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
        title: file.name.replace(/\.[^.]+$/, ''), url: '',
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
    const msg = node.type === Tree.FOLDER && kids.length
      ? `Delete “${node.title}” and the ${kids.length} item${kids.length === 1 ? '' : 's'} inside it?\n\nThis cannot be undone.`
      : `Delete “${node.title}”?\n\nThis cannot be undone.`;
    if (!confirm(msg)) return;

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
      if (!confirm(`Restore the backup from ${when}?\n\nIt holds ${count} item${count === 1 ? '' : 's'}. Everything currently in this browser will be replaced.`)) {
        bkMsg('');
        return;
      }

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
    DnD.init({
      getNodes: () => state.nodes,
      move,
      addFiles,
    });

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

    for (const el of document.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => el.closest('.modal').classList.remove('open'));
    }
    for (const modal of document.querySelectorAll('.modal')) {
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      closeMenu();
      for (const m of document.querySelectorAll('.modal.open')) m.classList.remove('open');
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
