"use server";
import { z } from "zod";
import { refresh } from "next/cache";
import { runAction } from "@/server/action";
import { requireActor } from "@/server/auth/session";
import { deliverQueued } from "@/server/email";
import { storage } from "@/server/storage";
import * as docs from "@/server/modules/documents/service";
import * as letters from "@/server/modules/documents/letters";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import * as bulk from "@/server/modules/documents/bulk";
import * as esign from "@/server/modules/documents/esign";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

async function fileFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_UPLOAD_BYTES) return "too_big" as const;
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}
const str = (form: FormData, k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };

/** Remove stored bytes once the database change is committed (best effort: a leftover blob is harmless). */
async function removeBlob(key: string | null) {
  if (key) await storage().remove(key).catch((e) => console.error("storage remove", e));
}

// ---------- folders ----------
const access = z.union([z.object({ type: z.literal("org") }), z.object({ type: z.enum(["departments", "locations"]), ids: z.array(uuid).max(500) })]);
export async function saveFolderAction(id: string | null, input: { name: string; access: unknown }) {
  const a = access.safeParse(input.access);
  if ((id && !uuid.safeParse(id).success) || !a.success || typeof input.name !== "string") return bad("Check the folder details.");
  return runAction((tx, actor) => docs.saveFolder(tx, actor, id, { name: input.name, access: a.data }));
}

export async function deleteFolderAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Folder not found.");
  return runAction((tx, actor) => docs.deleteFolder(tx, actor, id));
}

// ---------- documents ----------
export async function uploadDocumentAction(form: FormData) {
  const file = await fileFrom(form);
  if (!file) return bad("Choose a file to upload.", "file");
  if (file === "too_big") return bad("This file is larger than 5 MB.", "file");
  const folderId = str(form, "folderId");
  if (!uuid.safeParse(folderId).success) return bad("Pick a folder.", "folderId");
  return runAction((tx, actor) => docs.uploadDocument(tx, actor, {
    folderId, title: str(form, "title").slice(0, 160), description: str(form, "description").slice(0, 1000) || null,
    requiresAck: str(form, "requiresAck") === "1", blockUntilAck: str(form, "blockUntilAck") === "1", file,
  }));
}

const docInput = z.object({ title: z.string().max(160), description: z.string().max(1000).nullable().optional(), folderId: uuid, requiresAck: z.boolean(), blockUntilAck: z.boolean() });
export async function updateDocumentAction(id: string, input: z.input<typeof docInput>) {
  const p = docInput.safeParse(input);
  if (!uuid.safeParse(id).success || !p.success) return bad("Check the document details.");
  return runAction((tx, actor) => docs.updateDocument(tx, actor, id, p.data));
}

export async function deleteDocumentAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Document not found.");
  const r = await runAction((tx, actor) => docs.deleteDocument(tx, actor, id));
  if (r.ok) await removeBlob(r.data?.storageKey ?? null);
  return r.ok ? { ok: true as const } : r;
}

export async function acknowledgeDocumentAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Document not found.");
  return runAction((tx, actor) => docs.acknowledge(tx, actor, id));
}

export async function documentTrackingAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Document not found.");
  return runAction(async (tx, actor) => {
    const t = await docs.tracking(tx, actor, id);
    return { ...t, rows: t.rows.map((r) => ({ ...r, viewed_at: r.viewed_at?.toISOString() ?? null, acknowledged_at: r.acknowledged_at?.toISOString() ?? null })) };
  }, { refresh: false });
}

// ---------- the person's documents ----------
export async function uploadPersonDocumentAction(form: FormData) {
  const file = await fileFrom(form);
  if (!file) return bad("Choose a file to upload.", "file");
  if (file === "too_big") return bad("This file is larger than 5 MB.", "file");
  const employeeId = str(form, "employeeId");
  if (!uuid.safeParse(employeeId).success) return bad("Person not found.");
  return runAction((tx, actor) => docs.uploadPersonDocument(tx, actor, employeeId, { category: str(form, "category"), docType: str(form, "docType"), number: str(form, "number").slice(0, 60) || null, expiryDate: str(form, "expiryDate").slice(0, 10) || null, file }));
}

export async function deletePersonDocumentAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Document not found.");
  const r = await runAction((tx, actor) => docs.deletePersonDocument(tx, actor, id));
  if (r.ok) await removeBlob(r.data?.storageKey ?? null);
  return r.ok ? { ok: true as const } : r;
}

// ---------- letters ----------
const templateInput = z.object({ name: z.string().max(120), kind: z.string().max(40), body: z.string().max(200_000) });
export async function saveLetterTemplateAction(id: string | null, input: z.input<typeof templateInput>) {
  const p = templateInput.safeParse(input);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("The letter is too long.");
  return runAction((tx, actor) => letters.saveTemplate(tx, actor, id, p.data));
}

export async function deleteLetterTemplateAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Template not found.");
  return runAction((tx, actor) => letters.deleteTemplate(tx, actor, id));
}

export async function previewLetterAction(templateId: string, employeeId: string) {
  if (!uuid.safeParse(templateId).success || !uuid.safeParse(employeeId).success) return bad("Pick a template and a person.");
  return runAction((tx, actor) => letters.previewLetter(tx, actor, templateId, employeeId), { refresh: false });
}

export async function generateLetterAction(templateId: string, employeeId: string) {
  if (!uuid.safeParse(templateId).success || !uuid.safeParse(employeeId).success) return bad("Pick a template and a person.");
  return runAction((tx, actor) => letters.generateLetter(tx, actor, templateId, employeeId));
}

// ---------- docs2: review, bulk letters, erp Sign ----------

const reviewInput = z.object({ status: z.enum(["verified", "rejected", "pending"]), comment: z.string().max(500).nullable().optional(), expiryDate: z.string().max(10).nullable().optional() });
export async function reviewPersonDocumentAction(id: string, input: z.input<typeof reviewInput>) {
  const p = reviewInput.safeParse(input);
  if (!uuid.safeParse(id).success || !p.success) return bad("Check the review details.");
  return runAction((tx, actor) => docs.reviewPersonDocument(tx, actor, id, p.data));
}

export async function bulkRecipientsAction(filters: unknown) {
  return runAction(async (tx, actor) => {
    const people = await bulk.recipients(tx, actor, filters);
    return { count: people.length, sample: people.slice(0, 8).map((p) => ({ id: p.id, name: p.name, department: p.department })) };
  }, { refresh: false });
}

/** Create the batch, then render as much as fits in ~20 seconds; the rest continues on "Continue" or the daily job. */
export async function createBatchAction(templateId: string, filters: unknown) {
  if (!uuid.safeParse(templateId).success) return bad("Pick a template.", "templateId");
  const r = await runAction((tx, actor) => bulk.createBatch(tx, actor, { templateId, filters }), { refresh: false });
  if (!r.ok) return r;
  const actor = await requireActor();
  const run = await bulk.runBatch(actor.tenant.id, r.data!.id, { budgetMs: 20_000 });
  await deliverQueued(actor.tenant.id).catch(() => {});
  refresh();
  return { ok: true as const, data: { id: r.data!.id, total: r.data!.total, finished: run.finished } };
}

export async function continueBatchAction(batchId: string) {
  if (!uuid.safeParse(batchId).success) return bad("Batch not found.");
  const actor = await requireActor();
  const r = await runAction((tx, a) => bulk.batchDetail(tx, a, batchId), { refresh: false });   // permission check
  if (!r.ok) return r;
  if (!r.data) return bad("Batch not found.");
  const run = await bulk.runBatch(actor.tenant.id, batchId, { budgetMs: 20_000 });
  await deliverQueued(actor.tenant.id).catch(() => {});
  refresh();
  return { ok: true as const, data: run };
}

export async function batchDetailAction(batchId: string) {
  if (!uuid.safeParse(batchId).success) return bad("Batch not found.");
  return runAction(async (tx, actor) => {
    const d = await bulk.batchDetail(tx, actor, batchId);
    return d ? { ...d, created_at: d.created_at.toISOString(), finished_at: d.finished_at?.toISOString() ?? null } : null;
  }, { refresh: false });
}

const signersInput = z.array(z.object({ employeeId: uuid.nullable().optional(), email: z.string().max(200).nullable().optional(), name: z.string().max(120).nullable().optional(), title: z.string().max(80).nullable().optional() })).max(6);
export async function requestSignaturesAction(letterId: string, signers: unknown, message?: string | null) {
  const p = signersInput.safeParse(signers);
  if (!uuid.safeParse(letterId).success || !p.success) return bad("Check the signers.", "signers");
  return runAction((tx, actor) => esign.requestSignatures(tx, actor, letterId, p.data, typeof message === "string" ? message.slice(0, 500) : null));
}

export async function resendSignatureAction(requestId: string) {
  if (!uuid.safeParse(requestId).success) return bad("Request not found.");
  return runAction((tx, actor) => esign.resendSignature(tx, actor, requestId));
}

export async function cancelSignaturesAction(letterId: string) {
  if (!uuid.safeParse(letterId).success) return bad("Letter not found.");
  return runAction((tx, actor) => esign.cancelSignatures(tx, actor, letterId));
}

export async function signersAction(letterId: string) {
  if (!uuid.safeParse(letterId).success) return bad("Letter not found.");
  return runAction((tx) => esign.signersOf(tx, letterId), { refresh: false });
}
