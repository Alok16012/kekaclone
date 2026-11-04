/**
 * A minimal ZIP writer (store only, no compression) for bundles of PDFs: PDFs are already compressed, and this
 * keeps the bundle step free of native or transitive dependencies. Pure: bytes in, bytes out.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; bytes: Uint8Array; /** last modified, default: epoch of the call */ at?: Date };

/** File names inside the bundle: no paths, no control characters; duplicates get a (2), (3) … suffix. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "file";
    const n = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), n + 1);
    if (n === 0) return base;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? `${base.slice(0, dot)} (${n + 1})${base.slice(dot)}` : `${base} (${n + 1})`;
  });
}

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear());
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { date, time };
}

/** Build a ZIP (stored entries, UTF-8 names). Fine for a few hundred PDFs; everything stays in memory. */
export function buildZip(entries: ZipEntry[], now = new Date(0)): Uint8Array {
  const names = uniqueNames(entries.map((e) => e.name));
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  entries.forEach((e, i) => {
    const name = enc.encode(names[i]);
    const { date, time } = dosDateTime(e.at ?? now);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;
    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30); local.set(e.bytes, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local); centrals.push(central);
    offset += local.length;
  });
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const b of [...locals, ...centrals, end]) { out.set(b, p); p += b.length; }
  return out;
}

/** Read a stored-only ZIP back (used by tests and the smoke suite to check a bundle). */
export function readZip(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; bytes: Uint8Array }[] = [];
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true), nameLen = dv.getUint16(p + 26, true), extraLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extraLen;
    out.push({ name, bytes: bytes.subarray(start, start + size) });
    p = start + size;
  }
  return out;
}
