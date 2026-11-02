/**
 * A small, defensive ZIP reader for Form 16 bundles (one PDF per employee). Reads the central directory, supports stored and
 * deflated entries, and refuses encrypted, ZIP64 and oversized archives. No I/O; uses node:zlib for inflate.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; bytes: Uint8Array };
export type ZipLimits = { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number };
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 500, maxEntryBytes: 5 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 };

export class ZipError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/** Files in the archive (folders, macOS metadata and hidden files skipped), in archive order. */
export function readZip(buf: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22 || u32(buf, 0) !== 0x04034b50) throw new ZipError("This isn't a ZIP file.");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("This ZIP file is damaged (no directory found).");
  const count = u16(buf, eocd + 10), cdSize = u32(buf, eocd + 12), cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("Very large (ZIP64) archives aren't supported. Split it into smaller ZIP files.");
  if (count > limits.maxEntries) throw new ZipError(`The ZIP has ${count} files; at most ${limits.maxEntries} are allowed at a time.`);
  if (cdOffset + cdSize > buf.length) throw new ZipError("This ZIP file is damaged.");
  const out: ZipEntry[] = [];
  let p = cdOffset, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new ZipError("This ZIP file is damaged.");
    const flags = u16(buf, p + 8), method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20), size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split("/").pop() ?? "";
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || base.startsWith(".") || !base) continue;
    if (flags & 1) throw new ZipError("Password-protected ZIP files can't be read. Zip the PDFs again without a password.");
    if (compSize === 0xffffffff || size === 0xffffffff) throw new ZipError("Very large (ZIP64) archives aren't supported.");
    if (size > limits.maxEntryBytes) throw new ZipError(`${base} is larger than ${Math.round(limits.maxEntryBytes / 1024 / 1024)} MB.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("The files in this ZIP are too large altogether. Split it into smaller ZIP files.");
    if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) throw new ZipError("This ZIP file is damaged.");
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    if (start + compSize > buf.length) throw new ZipError("This ZIP file is damaged.");
    const raw = buf.subarray(start, start + compSize);
    let bytes: Uint8Array;
    if (method === 0) bytes = raw;
    else if (method === 8) {
      try { bytes = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, limits.maxEntryBytes) })); }
      catch { throw new ZipError(`${base} couldn't be unpacked.`); }
    } else throw new ZipError(`${base} uses a compression method erp can't read. Use a standard ZIP.`);
    if (bytes.length !== size) throw new ZipError(`${base} is damaged inside the ZIP.`);
    out.push({ name: base, bytes });
  }
  return out;
}

/** Builds a ZIP (stored, or deflated with `deflate: true`) — for tests and the demo seed. */
export function writeZip(entries: { name: string; bytes: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const le = (n: number, len: number) => { const a = new Uint8Array(len); for (let i = 0; i < len; i++) a[i] = (n / 2 ** (8 * i)) & 0xff; return a; };
  const cat = (...a: Uint8Array[]) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.bytes), method = e.deflate ? 8 : 0;
    const data = e.deflate ? new Uint8Array(deflateRawSync(e.bytes)) : e.bytes;
    const head = cat(le(0x04034b50, 4), le(20, 2), le(0, 2), le(method, 2), le(0, 4), le(crc, 4), le(data.length, 4), le(e.bytes.length, 4), le(name.length, 2), le(0, 2), name);
    parts.push(head, data);
    central.push(cat(le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(method, 2), le(0, 4), le(crc, 4), le(data.length, 4), le(e.bytes.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name));
    offset += head.length + data.length;
  }
  const cd = cat(...central);
  const end = cat(le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(offset, 4), le(0, 2));
  return cat(...parts, cd, end);
}
