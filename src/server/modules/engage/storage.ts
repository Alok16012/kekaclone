import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { storage } from "@/server/storage";

/**
 * Wall-image bytes at "<tenant>/<uuid>.<ext>"; the `files` table holds the metadata.
 * Local dev keeps them under UPLOAD_DIR (default ./.data/uploads). When object storage is configured
 * (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) the shared Storage adapter is used, under an "engage/" prefix.
 */
const ROOT = process.env.UPLOAD_DIR ? resolve(process.env.UPLOAD_DIR) : join(process.cwd(), ".data", "uploads");
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const remote = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

function pathFor(key: string) {
  if (!KEY.test(key)) throw new Error("bad storage key");
  const p = resolve(ROOT, key);
  if (!p.startsWith(ROOT + sep)) throw new Error("bad storage key");
  return p;
}

export async function putObject(key: string, bytes: Uint8Array) {
  if (!KEY.test(key)) throw new Error("bad storage key");
  if (remote()) return storage().put(`engage/${key}`, bytes, MIME[key.split(".").pop()!] ?? "application/octet-stream");
  const p = pathFor(key);
  await mkdir(resolve(p, ".."), { recursive: true });
  await writeFile(p, bytes, { flag: "wx" });   // never overwrite
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (!KEY.test(key)) throw new Error("bad storage key");
  if (remote()) { const b = await storage().get(`engage/${key}`); return b ? Buffer.from(b) : null; }
  try {
    return await readFile(pathFor(key));
  } catch {
    return null;
  }
}

export async function deleteObject(key: string) {
  if (!KEY.test(key)) throw new Error("bad storage key");
  if (remote()) return storage().remove(`engage/${key}`);
  await rm(pathFor(key), { force: true });
}
