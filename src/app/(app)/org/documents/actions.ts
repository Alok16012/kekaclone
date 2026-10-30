"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { storage } from "@/server/storage";
import * as docs from "@/server/modules/documents/service";
import * as letters from "@/server/modules/documents/letters";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";

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
  return runAction((tx, actor) => docs.uploadPersonDocument(tx, actor, employeeId, { category: str(form, "category"), docType: str(form, "docType"), number: str(form, "number").slice(0, 60) || null, file }));
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
