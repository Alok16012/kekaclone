"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { storage } from "@/server/storage";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import * as tax from "@/server/modules/tax/service";

const uuid = z.uuid();
const fyStart = z.string().regex(/^\d{4}-04-01$/);
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

async function removeBlobs(keys: string[] | undefined) {
  for (const k of keys ?? []) await storage().remove(k).catch((e) => console.error("storage remove", e));
}
const withBlobs = async <T extends { removedKeys?: string[] } | undefined>(p: Promise<{ ok: true; data?: T } | { ok: false; error: string; field?: string }>) => {
  const r = await p;
  if (r.ok) { await removeBlobs(r.data?.removedKeys); return { ok: true as const }; }
  return r;
};

export async function saveRegimeAction(fy: string, regime: "old" | "new") {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return runAction((tx, actor) => tax.saveRegime(tx, actor, fy, regime));
}

export async function saveSectionAction(fy: string, section: string, items: { item: string; declaredPaise: number }[]) {
  if (!fyStart.safeParse(fy).success || typeof section !== "string") return bad("Pick a financial year.");
  return withBlobs(runAction((tx, actor) => tax.saveSection(tx, actor, fy, section, items)));
}

export async function saveRentAction(fy: string, periods: unknown) {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return withBlobs(runAction((tx, actor) => tax.saveRent(tx, actor, fy, periods)));
}

export async function saveHomeLoanAction(fy: string, input: unknown) {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return withBlobs(runAction((tx, actor) => tax.saveHomeLoan(tx, actor, fy, input)));
}

export async function savePreviousEmployerAction(fy: string, input: unknown) {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return runAction((tx, actor) => tax.savePreviousEmployer(tx, actor, fy, input));
}

export async function saveOtherIncomeAction(fy: string, input: unknown) {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return runAction((tx, actor) => tax.saveOtherIncome(tx, actor, fy, input));
}

export async function submitDeclarationAction(fy: string) {
  if (!fyStart.safeParse(fy).success) return bad("Pick a financial year.");
  return runAction((tx, actor) => tax.submitDeclaration(tx, actor, fy));
}

export async function savePanAction(pan: string) {
  if (typeof pan !== "string") return bad("Enter your PAN.", "pan");
  return runAction((tx, actor) => tax.savePan(tx, actor, actor.employeeId, pan));
}

export async function uploadProofAction(form: FormData) {
  const itemId = form.get("itemId");
  if (typeof itemId !== "string" || !uuid.safeParse(itemId).success) return bad("Declaration item not found.");
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return bad("Pick a file to upload.", "files");
  if (files.length > tax.MAX_PROOFS) return bad(`Attach up to ${tax.MAX_PROOFS} files per item.`, "files");
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) return bad("Each file must be 5 MB or smaller.", "files");
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return runAction(async (tx, actor) => { await tax.uploadProofs(tx, actor, itemId, uploads); });
}

export async function removeProofAction(itemId: string, fileId: string) {
  if (!uuid.safeParse(itemId).success || !uuid.safeParse(fileId).success) return bad("File not found.");
  return withBlobs(runAction((tx, actor) => tax.removeProof(tx, actor, itemId, fileId)));
}
