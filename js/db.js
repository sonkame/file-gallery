/* ==================== db.js ====================
   IndexedDB access, promisified.

   Three stores, deliberately separated:
     nodes   the tree — small records, read on every render
     thumbs  downscaled previews, read only for what's on screen
     blobs   full-resolution originals, read only on export or full view

   IndexedDB deserializes whole records. Keeping image data out of `nodes`
   is what lets a folder of 5,000 images draw without touching a byte of
   full-resolution data. Blobs store directly — the structured clone
   algorithm handles them natively. */

const DB = (() => {
  const NAME = 'file-gallery';
  const VERSION = 1;
  const NODES = 'nodes', THUMBS = 'thumbs', BLOBS = 'blobs';

  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(NODES)) {
          const s = db.createObjectStore(NODES, { keyPath: 'id' });
          s.createIndex('parentId', 'parentId', { unique: false });
        }
        if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('Could not open the database.'));
      req.onblocked = () => reject(new Error('Database blocked — close other tabs of this site and retry.'));
    });
    return dbp;
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /* Resolves on transaction.complete rather than on the last request's
     success. A request can succeed inside a transaction that later aborts;
     waiting for complete is what actually means "written". */
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted — storage may be full.'));
      Promise.resolve(fn(t)).then(v => { result = v; }).catch(err => {
        try { t.abort(); } catch (_) {}
        reject(err);
      });
    });
  }

  /* ----- nodes ----- */

  const allNodes = () => tx([NODES], 'readonly', t => wrap(t.objectStore(NODES).getAll()));

  const putNodes = list => tx([NODES], 'readwrite', t => {
    const s = t.objectStore(NODES);
    for (const n of list) s.put(n);
  });

  const putNode = node => putNodes([node]);

  /* ----- images ----- */

  const getThumb = id => tx([THUMBS], 'readonly', t => wrap(t.objectStore(THUMBS).get(id)));
  const getBlob = id => tx([BLOBS], 'readonly', t => wrap(t.objectStore(BLOBS).get(id)));

  const putImage = (id, blob, thumb, meta = {}) =>
    tx([BLOBS, THUMBS], 'readwrite', t => {
      t.objectStore(BLOBS).put({ id, blob, name: meta.name || '', mime: blob.type || '' });
      t.objectStore(THUMBS).put({ id, blob: thumb });
    });

  /* Every stored original's size, without loading the originals. Drives the
     100MB threshold that picks the backup format. */
  async function totalBlobBytes() {
    return tx([BLOBS], 'readonly', t => new Promise((resolve, reject) => {
      let total = 0;
      const req = t.objectStore(BLOBS).openCursor();
      req.onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return resolve(total);
        if (cur.value && cur.value.blob) total += cur.value.blob.size;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  }

  async function allBlobs() {
    return tx([BLOBS], 'readonly', t => wrap(t.objectStore(BLOBS).getAll()));
  }

  /* ----- delete ----- */

  /* Nodes and their image data go in one transaction. Splitting them would
     let a failure halfway through leave orphaned blobs consuming disk with
     nothing referencing them. */
  const deleteNodes = ids => tx([NODES, THUMBS, BLOBS], 'readwrite', t => {
    const n = t.objectStore(NODES), th = t.objectStore(THUMBS), b = t.objectStore(BLOBS);
    for (const id of ids) { n.delete(id); th.delete(id); b.delete(id); }
  });

  const clearAll = () => tx([NODES, THUMBS, BLOBS], 'readwrite', t => {
    t.objectStore(NODES).clear();
    t.objectStore(THUMBS).clear();
    t.objectStore(BLOBS).clear();
  });

  /* Bulk restore path. One transaction so a partial restore can't happen. */
  const replaceAll = (nodes, images) => tx([NODES, THUMBS, BLOBS], 'readwrite', t => {
    const n = t.objectStore(NODES), th = t.objectStore(THUMBS), b = t.objectStore(BLOBS);
    n.clear(); th.clear(); b.clear();
    for (const node of nodes) n.put(node);
    for (const img of images) {
      b.put({ id: img.id, blob: img.blob, name: img.name || '', mime: img.blob.type || '' });
      if (img.thumb) th.put({ id: img.id, blob: img.thumb });
    }
  });

  return {
    open, allNodes, putNode, putNodes,
    getThumb, getBlob, putImage, totalBlobBytes, allBlobs,
    deleteNodes, clearAll, replaceAll,
  };
})();

if (typeof module !== 'undefined') module.exports = DB;
