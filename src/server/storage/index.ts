import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Tx } from "@/server/db";
import { AppError } from "@/server/db";
import { SupabaseStorage } from "./supabase";

/**
 * Where file bytes live. Metadata (name, MIME, size, owner) is in the `files` table; bytes go to a Storage.
 * Dev: a local directory (STORAGE_DIR, default ./.storage). With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set, bytes go to
 * a private Supabase Storage bucket instead (see ./supabase.ts); callers never notice.
 */
export interface Storage {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    if (!/^[a-z0-9][a-z0-9/_-]*(\.[a-z0-9]+)?$/i.test(key) || key.includes("..")) throw new Error("bad storage key");
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("bad storage key");
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: "wx" });   // never overwrite
  }
  async get(key: string) {
    try { return new Uint8Array(await readFile(this.path(key))); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
  }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

declare global { var __erpStorage: Storage | undefined }
export function storage(): Storage {
  return (globalThis.__erpStorage ??= process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_BUCKET || undefined)
    : new LocalStorage(process.env.STORAGE_DIR ?? join(process.cwd(), ".storage")));
}

/**
 * Store bytes and record them in `files` (inside the caller's transaction). Bytes are written first under a fresh
 * random key, so a rolled-back transaction leaves at most an orphan blob, never a row pointing at nothing.
 */
export async function saveFile(tx: Tx, a: { tenantId: string; userId: string | null; name: string; mime: string; bytes: Uint8Array; ext: string }) {
  if (a.bytes.byteLength > 25 * 1024 * 1024) throw new AppError("invalid", "This file is too large.");
  const key = `${a.tenantId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${a.ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin"}`;
  await storage().put(key, a.bytes, a.mime);
  const [f] = await tx<{ id: string }[]>`
    insert into files (tenant_id, storage_key, name, mime, size_bytes, uploaded_by)
    values (${a.tenantId}, ${key}, ${a.name}, ${a.mime}, ${a.bytes.byteLength}, ${a.userId}) returning id`;   // scan_status stays 'pending' until a scanner exists
  return f.id;
}
