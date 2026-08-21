/* ==================== zip.js ====================
   Minimal store-only ZIP writer and reader. No dependencies — the site has
   to work offline from disk, so a CDN library isn't an option.

   Store-only (compression method 0) is deliberate, not lazy: PNG and JPEG
   payloads are already compressed, so deflating them costs CPU for roughly
   one percent of size.

   Field layouts follow APPNOTE.TXT. Signatures:
     local file header      0x04034b50
     central directory      0x02014b50
     end of central dir     0x06064b50 (zip64) / 0x06054b50
     zip64 eocd locator     0x07064b50 */

const Zip = (() => {
  const LOCAL_SIG = 0x04034b50;
  const CD_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const Z64_EOCD_SIG = 0x06064b50;
  const Z64_LOC_SIG = 0x07064b50;

  const U32_MAX = 0xffffffff;
  const U16_MAX = 0xffff;
  const CHUNK = 4 * 1024 * 1024; // CRC is streamed in 4MB slices

  /* ----- CRC-32 ----- */

  let TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[i] = c >>> 0;
    }
    return TABLE;
  }

  function crc32Update(crc, bytes) {
    const t = crcTable();
    let c = crc;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
  }

  /* Streams the blob in slices so a multi-GB entry never lands in memory
     all at once. The blob itself stays a disk-backed reference. */
  async function crc32Blob(blob) {
    let crc = 0xffffffff;
    for (let off = 0; off < blob.size; off += CHUNK) {
      const buf = await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer();
      crc = crc32Update(crc, new Uint8Array(buf));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* ----- byte helpers ----- */

  function dosDateTime(date) {
    const y = date.getFullYear();
    // The DOS epoch starts at 1980; anything earlier clamps rather than wrapping.
    const year = y < 1980 ? 0 : y - 1980;
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dt = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xffff, date: dt & 0xffff };
  }

  function makeWriter(size) {
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const arr = new Uint8Array(buf);
    let pos = 0;
    return {
      u16(v) { view.setUint16(pos, v, true); pos += 2; },
      u32(v) { view.setUint32(pos, v >>> 0, true); pos += 4; },
      u64(v) { view.setBigUint64(pos, BigInt(v), true); pos += 8; },
      bytes(b) { arr.set(b, pos); pos += b.length; },
      done() { return arr.subarray(0, pos); },
    };
  }

  const utf8 = s => new TextEncoder().encode(s);

  /* ----- writing ----- */

  /* entries: [{ name, blob }] -> Blob
     Parts are collected as an array and handed to the Blob constructor at the
     end, so the browser can back the archive with disk rather than holding it
     in memory. */
  async function write(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const { time, date } = dosDateTime(now);

    for (const entry of entries) {
      const nameBytes = utf8(entry.name);
      const blob = entry.blob;
      const size = blob.size;
      const crc = await crc32Blob(blob);
      const needs64 = size >= U32_MAX || offset >= U32_MAX;

      // Local header. ZIP64 puts the true sizes in an extra field and
      // leaves the 32-bit fields saturated at 0xFFFFFFFF.
      const extraLen = needs64 ? 20 : 0;
      const lh = makeWriter(30 + nameBytes.length + extraLen);
      lh.u32(LOCAL_SIG);
      lh.u16(needs64 ? 45 : 20);   // version needed
      lh.u16(0x0800);              // flag: UTF-8 filenames
      lh.u16(0);                   // method: store
      lh.u16(time);
      lh.u16(date);
      lh.u32(crc);
      lh.u32(needs64 ? U32_MAX : size);
      lh.u32(needs64 ? U32_MAX : size);
      lh.u16(nameBytes.length);
      lh.u16(extraLen);
      lh.bytes(nameBytes);
      if (needs64) {
        lh.u16(0x0001);            // zip64 extended information
        lh.u16(16);
        lh.u64(size);              // uncompressed
        lh.u64(size);              // compressed
      }

      const localBytes = lh.done();
      parts.push(localBytes, blob);

      central.push({ nameBytes, crc, size, offset, needs64 });
      offset += localBytes.length + size;
    }

    // Central directory.
    const cdStart = offset;
    for (const e of central) {
      const big = e.size >= U32_MAX;
      const bigOff = e.offset >= U32_MAX;
      const extraFields = (big ? 16 : 0) + (bigOff ? 8 : 0);
      const extraLen = extraFields ? extraFields + 4 : 0;

      const cd = makeWriter(46 + e.nameBytes.length + extraLen);
      cd.u32(CD_SIG);
      cd.u16(45);                          // version made by
      cd.u16(extraLen ? 45 : 20);          // version needed
      cd.u16(0x0800);
      cd.u16(0);
      cd.u16(time);
      cd.u16(date);
      cd.u32(e.crc);
      cd.u32(big ? U32_MAX : e.size);
      cd.u32(big ? U32_MAX : e.size);
      cd.u16(e.nameBytes.length);
      cd.u16(extraLen);
      cd.u16(0);                           // comment length
      cd.u16(0);                           // disk number start
      cd.u16(0);                           // internal attrs
      cd.u32(0);                           // external attrs
      cd.u32(bigOff ? U32_MAX : e.offset);
      cd.bytes(e.nameBytes);
      if (extraLen) {
        cd.u16(0x0001);
        cd.u16(extraFields);
        if (big) { cd.u64(e.size); cd.u64(e.size); }
        if (bigOff) cd.u64(e.offset);
      }

      const bytes = cd.done();
      parts.push(bytes);
      offset += bytes.length;
    }

    const cdSize = offset - cdStart;
    const need64End = central.length >= U16_MAX || cdSize >= U32_MAX || cdStart >= U32_MAX;

    if (need64End) {
      const z = makeWriter(56 + 20);
      z.u32(Z64_EOCD_SIG);
      z.u64(44);                 // size of this record, minus its first 12 bytes
      z.u16(45);
      z.u16(45);
      z.u32(0);
      z.u32(0);
      z.u64(central.length);
      z.u64(central.length);
      z.u64(cdSize);
      z.u64(cdStart);
      // ZIP64 end of central directory locator
      z.u32(Z64_LOC_SIG);
      z.u32(0);
      z.u64(offset);
      z.u32(1);
      parts.push(z.done());
    }

    const eocd = makeWriter(22);
    eocd.u32(EOCD_SIG);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(Math.min(central.length, U16_MAX));
    eocd.u16(Math.min(central.length, U16_MAX));
    eocd.u32(Math.min(cdSize, U32_MAX));
    eocd.u32(Math.min(cdStart, U32_MAX));
    eocd.u16(0);
    parts.push(eocd.done());

    return new Blob(parts, { type: 'application/zip' });
  }

  /* ----- reading ----- */

  function findEOCD(bytes) {
    // The EOCD sits at the end, but a trailing comment can push it back
    // by up to 64KB, so scan backwards for the signature.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - (22 + 0xffff));
    for (let i = bytes.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) return i;
    }
    return -1;
  }

  function readZip64Extra(bytes, start, len, need) {
    // Walk the extra-field chain looking for the 0x0001 header. Fields
    // appear in fixed order but only when the 32-bit slot was saturated.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = start;
    const end = start + len;
    while (p + 4 <= end) {
      const id = view.getUint16(p, true);
      const size = view.getUint16(p + 2, true);
      if (id === 0x0001) {
        let q = p + 4;
        const out = {};
        if (need.size) { out.size = Number(view.getBigUint64(q, true)); q += 8; out.compressed = Number(view.getBigUint64(q, true)); q += 8; }
        if (need.offset) { out.offset = Number(view.getBigUint64(q, true)); q += 8; }
        return out;
      }
      p += 4 + size;
    }
    return {};
  }

  /* blob -> [{ name, blob }] */
  async function read(blob) {
    const all = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(all.buffer);

    const eocdPos = findEOCD(all);
    if (eocdPos === -1) throw new Error('Not a zip file — no end-of-central-directory record.');

    let count = view.getUint16(eocdPos + 10, true);
    let cdStart = view.getUint32(eocdPos + 16, true);

    // Saturated fields mean the real values live in the ZIP64 record, which
    // is located through the locator immediately preceding the EOCD.
    if (count === U16_MAX || cdStart === U32_MAX) {
      const locPos = eocdPos - 20;
      if (locPos >= 0 && view.getUint32(locPos, true) === Z64_LOC_SIG) {
        const z64 = Number(view.getBigUint64(locPos + 8, true));
        if (view.getUint32(z64, true) === Z64_EOCD_SIG) {
          count = Number(view.getBigUint64(z64 + 32, true));
          cdStart = Number(view.getBigUint64(z64 + 48, true));
        }
      }
    }

    const entries = [];
    let p = cdStart;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== CD_SIG) break;
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      let size = view.getUint32(p + 24, true);
      let localOff = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(all.subarray(p + 46, p + 46 + nameLen));

      if (size === U32_MAX || localOff === U32_MAX) {
        const z = readZip64Extra(all, p + 46 + nameLen, extraLen, {
          size: size === U32_MAX,
          offset: localOff === U32_MAX,
        });
        if (z.size !== undefined) size = z.size;
        if (z.offset !== undefined) localOff = z.offset;
      }

      // The local header's own name/extra lengths can differ from the central
      // directory's, so data start is computed from the local header itself.
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;

      entries.push({ name, blob: blob.slice(dataStart, dataStart + size) });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  /* Magic-byte sniff used by restore to tell a zip from a JSON backup. */
  async function isZip(blob) {
    if (blob.size < 4) return false;
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  }

  return { write, read, isZip, crc32Blob, crc32Update };
})();

if (typeof module !== 'undefined') module.exports = Zip;
