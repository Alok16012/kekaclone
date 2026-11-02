"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { storage } from "@/server/storage";
import * as tax from "@/server/modules/tax/service";

const uuid = z.uuid();
const fyStart = z.string().regex(/^\d{4}-04-01$/);
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const MAX_UPLOAD = 5 * 1024 * 1024;

async function removeBlobs(keys: string[] | undefined) {
  for (const k of keys ?? []) await storage().remove(k).catch((e) => console.error("storage remove", e));
}

export async function verifyProofAction(itemId: string, input: { decision: "accept" | "partial" | "reject"; acceptedPaise?: number; comment?: string }) {
  if (!uuid.safeParse(itemId).success) return bad("Proof not found.");
  return runAction((tx, actor) => tax.verifyProof(tx, actor, itemId, input));
}

export async function saveTaxSettingsAction(payGroupId: string, settings: unknown) {
  if (!uuid.safeParse(payGroupId).success) return bad("Pay group not found.");
  return runAction((tx, actor) => tax.saveTaxSettings(tx, actor, payGroupId, settings));
}

/** Form 16 Part A: ZIPs of PDFs or PDFs, named by PAN. Up to 5 MB per request (the server-action body limit). */
export async function uploadForm16Action(form: FormData) {
  const fy = form.get("fyStart");
  if (typeof fy !== "string" || !fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return bad("Pick the ZIP or PDF files to upload.", "files");
  if (files.reduce((s, f) => s + f.size, 0) > MAX_UPLOAD) return bad("Upload at most 5 MB at a time. Split large ZIPs into smaller ones.", "files");
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const r = await runAction((tx, actor) => tax.uploadForm16(tx, actor, fy, uploads));
  if (!r.ok) return r;
  await removeBlobs(r.data?.removedKeys);
  return { ok: true as const, data: { matched: r.data!.matched, unmatched: r.data!.unmatched } };
}

export async function publishForm16Action(fy: string, employeeIds: string[] | "all") {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  if (employeeIds !== "all" && !z.array(uuid).max(5000).safeParse(employeeIds).success) return bad("Pick who to publish for.");
  return runAction((tx, actor) => tax.publishForm16(tx, actor, fy, employeeIds));
}

export async function deleteForm16Action(docId: string) {
  if (!uuid.safeParse(docId).success) return bad("Form 16 not found.");
  const r = await runAction((tx, actor) => tax.deleteForm16(tx, actor, docId));
  if (r.ok) await removeBlobs(r.data?.removedKeys);
  return r.ok ? { ok: true as const } : r;
}
