/* ==================== images.js ====================
   Thumbnail generation and blob/data-URL conversion.

   Split out from ui.js because backup.js needs thumbnail generation too:
   thumbnails aren't stored in backups, they're regenerated on restore. */

const Images = (() => {
  const MAX_EDGE = 400;
  const QUALITY = 0.8;

  const EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
  };

  const extFor = mime => EXT_BY_MIME[mime] || 'bin';
  const mimeForExt = ext => Object.keys(EXT_BY_MIME).find(m => EXT_BY_MIME[m] === ext) || 'application/octet-stream';

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image.')); };
      img.src = url;
    });
  }

  /* Downscales to fit MAX_EDGE. Returns a JPEG blob, except for formats
     where re-encoding would destroy the point of the file: SVG is vector
     and has no meaningful raster thumbnail size, so it's passed through. */
  async function makeThumb(blob) {
    if (blob.type === 'image/svg+xml') return blob;

    let img;
    try {
      img = await loadImage(blob);
    } catch (_) {
      return blob; // unreadable by the decoder; keep the original as its own preview
    }

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return blob;

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    if (scale === 1 && blob.size < 120 * 1024) return blob; // already small enough to serve directly

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const out = await new Promise(res => canvas.toBlob(res, 'image/jpeg', QUALITY));
    return out || blob;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Could not read image data.'));
      r.readAsDataURL(blob);
    });
  }

  async function dataURLToBlob(url) {
    const res = await fetch(url);
    return res.blob();
  }

  return { makeThumb, blobToDataURL, dataURLToBlob, extFor, mimeForExt, MAX_EDGE };
})();

if (typeof module !== 'undefined') module.exports = Images;
