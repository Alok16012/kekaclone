import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Minimal local file storage for wall images (development and single-server installs).
 * Bytes live under UPLOAD_DIR (default ./.data/uploads) at "<tenant>/<uuid>.<ext>"; the `files` table holds the metadata.
 * Production swaps this for private object storage with signed URLs (see architecture.md), keeping the same three calls.
 */
const ROOT = resolve(process.env.UPLOAD_DIR ?? join(process.cwd(), ".data", "uploads"));
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

function pathFor(key: string) {
  if (!KEY.test(key)) throw new Error("bad storage key");
  const p = resolve(ROOT, key);
  if (!p.startsWith(ROOT + sep)) throw new Error("bad storage key");
  return p;
}

export async function putObject(key: string, bytes: Uint8Array) {
  const p = pathFor(key);
  await mkdir(resolve(p, ".."), { recursive: true });
  await writeFile(p, bytes, { flag: "wx" });   // never overwrite
}

export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await readFile(pathFor(key));
  } catch {
    return null;
  }
}

export async function deleteObject(key: string) {
  await rm(pathFor(key), { force: true });
}
