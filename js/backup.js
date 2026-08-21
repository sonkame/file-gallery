/* ==================== backup.js ====================
   Export and restore. The site keeps everything in one browser; clearing
   site data, switching machines or losing the disk wipes it. The backup
   file is the only thing that survives that, so the round trip has to be
   exact.

   Format is chosen by raw image bytes:
     <= 100MB  a single .json with images embedded as base64
     >  100MB  a .zip with data.json plus images/<id>.<ext>

   The threshold measures raw bytes, not encoded size, because base64
   inflates by about a third — deciding on encoded size would let a 100MB
   image set leave as a 133MB JSON file.

   Both formats carry a byte-identical tree payload, so the two restore
   paths converge immediately after unpacking. That's what keeps them
   genuinely interchangeable instead of drifting apart over time. */

const Backup = (() => {
  const FORMAT = 'filegallery.backup';
  const VERSION = 1;
  const THRESHOLD = 100 * 1024 * 1024;
  const LAST_KEY = 'filegallery.backup.last'; // epoch ms of a real saved file
  const SIG_KEY = 'filegallery.backup.sig';   // data fingerprint at that save

  const stamp = () => new Date().toISOString().slice(0, 10);

  /* ----- change tracking -----
     Fingerprints the tree so the nudge dot can answer "has anything changed
     since the last backup?". Node count plus latest mtime is enough to catch
     adds, edits, moves and deletes without hashing image data. */
  function signature(nodes) {
    let latest = 0;
    for (const n of nodes) {
      if (n.updatedAt > latest) latest = n.updatedAt;
      if (n.createdAt > latest) latest = n.createdAt;
    }
    return nodes.length + ':' + latest;
  }

  async function isDirty() {
    const nodes = await DB.allNodes();
    if (!nodes.length) return false; // nothing to lose yet
    return localStorage.getItem(SIG_KEY) !== signature(nodes);
  }

  function lastBackupAt() {
    const v = Number(localStorage.getItem(LAST_KEY));
    return v > 0 ? new Date(v) : null;
  }

  async function markSaved(nodes) {
    localStorage.setItem(LAST_KEY, String(Date.now()));
    localStorage.setItem(SIG_KEY, signature(nodes));
  }

  /* ----- export ----- */

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function exportAll(onProgress = () => {}) {
    const nodes = await DB.allNodes();
    if (!nodes.length) throw new Error('Nothing to back up yet.');

    onProgress('Measuring…');
    const totalBytes = await DB.totalBlobBytes();
    const useZip = totalBytes > THRESHOLD;

    const meta = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), nodes };

    let blob, filename;
    if (useZip) {
      onProgress('Packing images…');
      const images = await DB.allBlobs();
      const entries = [{
        name: 'data.json',
        blob: new Blob([JSON.stringify(meta)], { type: 'application/json' }),
      }];
      for (const img of images) {
        entries.push({ name: `images/${img.id}.${Images.extFor(img.mime || img.blob.type)}`, blob: img.blob });
      }
      onProgress('Writing zip…');
      blob = await Zip.write(entries);
      filename = `gallery-backup-${stamp()}.zip`;
    } else {
      onProgress('Encoding images…');
      const images = await DB.allBlobs();
      const map = {};
      for (const img of images) map[img.id] = await Images.blobToDataURL(img.blob);
      blob = new Blob([JSON.stringify({ ...meta, images: map })], { type: 'application/json' });
      filename = `gallery-backup-${stamp()}.json`;
    }

    download(blob, filename);
    await markSaved(nodes);
    return { filename, bytes: blob.size, format: useZip ? 'zip' : 'json' };
  }

  /* ----- import ----- */

  function validate(meta) {
    if (!meta || meta.format !== FORMAT) {
      throw new Error("That file isn't a File Gallery backup.");
    }
    if (Number(meta.version) > VERSION) {
      throw new Error('That backup was made by a newer version of this site.');
    }
    if (!Array.isArray(meta.nodes)) {
      throw new Error('That backup is damaged — it has no folder data.');
    }
    return meta;
  }

  /* Reads either format into the same shape: { meta, images: [{id, blob}] }.
     Everything downstream of here is format-blind. */
  async function parse(file) {
    if (await Zip.isZip(file)) {
      const entries = await Zip.read(file);
      const dataEntry = entries.find(e => e.name === 'data.json');
      if (!dataEntry) throw new Error('That zip has no data.json — it may not be a gallery backup.');
      const meta = validate(JSON.parse(await dataEntry.blob.text()));

      const images = [];
      for (const e of entries) {
        if (!e.name.startsWith('images/')) continue;
        const base = e.name.slice('images/'.length);
        const dot = base.lastIndexOf('.');
        const id = dot === -1 ? base : base.slice(0, dot);
        const ext = dot === -1 ? '' : base.slice(dot + 1);
        images.push({ id, blob: new Blob([e.blob], { type: Images.mimeForExt(ext) }) });
      }
      return { meta, images };
    }

    let meta;
    try {
      meta = validate(JSON.parse(await file.text()));
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error("Couldn't read that file — it may be damaged or not a backup.");
      throw err;
    }

    const images = [];
    for (const [id, url] of Object.entries(meta.images || {})) {
      images.push({ id, blob: await Images.dataURLToBlob(url) });
    }
    delete meta.images;
    return { meta, images };
  }

  /* Destructive and irreversible, so the caller confirms first — with the
     backup's own date, not a generic prompt. Thumbnails are regenerated
     rather than restored: they're derived data, and rebuilding them keeps a
     restored gallery from showing previews that no longer match. */
  async function restore(file, onProgress = () => {}) {
    onProgress('Reading backup…');
    const { meta, images } = await parse(file);

    onProgress('Rebuilding previews…');
    for (const img of images) {
      img.thumb = await Images.makeThumb(img.blob);
    }

    onProgress('Restoring…');
    await DB.replaceAll(meta.nodes, images);
    await markSaved(meta.nodes);
    return { nodes: meta.nodes.length, images: images.length, savedAt: meta.savedAt };
  }

  return { exportAll, restore, parse, validate, signature, isDirty, lastBackupAt, markSaved, THRESHOLD, FORMAT, VERSION };
})();

if (typeof module !== 'undefined') module.exports = Backup;
