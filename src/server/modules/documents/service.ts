import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { saveFile } from "@/server/storage";
import { canSeeFolder, parseAccess, validateUpload, type FolderAccess } from "./rules";

export const DOCS = "documents.manage";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/**
 * Company documents, folders and letter templates are company-wide, so managing them needs documents.manage with no
 * department / location scope. A scoped HR admin still handles their own people's documents and letters (canFor).
 */
export const canManageDocs = (actor: Actor) => canFor(actor, DOCS, EVERYWHERE);

async function me(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { status: string })[]>`select department_id, location_id, legal_entity_id, business_unit_id, status from employees where id = ${employeeId}`;
  return p ?? { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null, status: "relieved" };
}

/** Employees a folder's access setting covers (people who haven't left). */
function audienceWhere(tx: Tx, access: FolderAccess) {
  return access.type === "org" ? tx`e.status <> 'relieved'`
    : access.type === "departments" ? tx`e.status <> 'relieved' and e.department_id = any(${access.ids}::uuid[])`
    : tx`e.status <> 'relieved' and e.location_id = any(${access.ids}::uuid[])`;
}

// ---------- folders ----------
export type DocRow = {
  id: string; folder_id: string; title: string; description: string | null; file_id: string; file_name: string; mime: string; size_bytes: number;
  requires_ack: boolean; block_portal_until_ack: boolean; created_at: Date;
  viewed_at: Date | null; acknowledged_at: Date | null;           // the actor's own
  audience?: number; viewed?: number; acknowledged?: number;       // HR only
};
export type FolderRow = { id: string; name: string; access: FolderAccess; docs: DocRow[] };

/** Folders the actor can see (HR sees all), with documents, the actor's own view/ack state and, for HR, tracking counts. */
export async function libraryFor(tx: Tx, actor: Actor): Promise<FolderRow[]> {
  const manage = canManageDocs(actor);
  const p = await me(tx, actor.employeeId);
  const folders = (await tx<{ id: string; name: string; access: unknown }[]>`select id, name, access from document_folders order by name`)
    .map((f) => ({ id: f.id, name: f.name, access: parseAccess(f.access) }))
    .filter((f) => manage || canSeeFolder(f.access, p));
  if (!folders.length) return [];
  const docs = await tx<(Omit<DocRow, "size_bytes"> & { size_bytes: bigint | number })[]>`
    select d.id, d.folder_id, d.title, d.description, d.file_id, f.name as file_name, f.mime, f.size_bytes, d.requires_ack, d.block_portal_until_ack, d.created_at,
      a.viewed_at, a.acknowledged_at
    from org_documents d join files f on f.id = d.file_id
    left join document_acks a on a.document_id = d.id and a.employee_id = ${actor.employeeId}
    where d.folder_id = any(${folders.map((f) => f.id)}::uuid[]) order by d.created_at desc`;
  const byFolder = new Map(folders.map((f) => [f.id, { ...f, docs: [] as DocRow[] }]));
  for (const d of docs) byFolder.get(d.folder_id)?.docs.push({ ...d, size_bytes: Number(d.size_bytes) });
  if (manage) {
    for (const f of byFolder.values()) {
      if (!f.docs.length) continue;
      const [{ audience }] = await tx<{ audience: number }[]>`select count(*)::int as audience from employees e where ${audienceWhere(tx, f.access)}`;
      const counts = await tx<{ document_id: string; viewed: number; acknowledged: number }[]>`
        select a.document_id, count(*) filter (where a.viewed_at is not null)::int as viewed, count(*) filter (where a.acknowledged_at is not null)::int as acknowledged
        from document_acks a join employees e on e.id = a.employee_id
        where a.document_id = any(${f.docs.map((d) => d.id)}::uuid[]) and ${audienceWhere(tx, f.access)} group by a.document_id`;
      const c = new Map(counts.map((x) => [x.document_id, x]));
      for (const d of f.docs) { d.audience = audience; d.viewed = c.get(d.id)?.viewed ?? 0; d.acknowledged = c.get(d.id)?.acknowledged ?? 0; }
    }
  }
  return [...byFolder.values()];
}

function checkAccess(raw: unknown): FolderAccess {
  const a = parseAccess(raw);
  const r = (raw ?? {}) as { type?: string };
  if ((r.type === "departments" || r.type === "locations") && a.type === "org") throw new AppError("invalid", `Pick at least one ${r.type === "departments" ? "department" : "location"}, or share with everyone.`, "access");
  return a;
}

export async function saveFolder(tx: Tx, actor: Actor, id: string | null, input: { name: string; access: unknown }) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the folder a name.", "name");
  const access = checkAccess(input.access);
  if (access.type !== "org") {
    const table = access.type === "departments" ? tx`departments` : tx`locations`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${table} where id = any(${access.ids}::uuid[])`;
    if (n !== access.ids.length) throw new AppError("invalid", "Some of the chosen teams or locations no longer exist.", "access");
  }
  const [dup] = await tx<{ id: string }[]>`select id from document_folders where lower(name) = lower(${name}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "A folder with this name already exists.", "name");
  if (id) {
    const [r] = await tx<{ id: string }[]>`update document_folders set name = ${name}, access = ${tx.json(access)} where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Folder not found.");
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into document_folders (tenant_id, name, access) values (${actor.tenant.id}, ${name}, ${tx.json(access)}) returning id`;
  return r;
}

export async function deleteFolder(tx: Tx, actor: Actor, id: string) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from org_documents where folder_id = ${id}`;
  if (n) throw new AppError("invalid", "Move or delete the documents in this folder first.");
  const r = await tx`delete from document_folders where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Folder not found.");
}

// ---------- documents ----------
export type UploadInput = { folderId: string; title: string; description?: string | null; requiresAck: boolean; blockUntilAck: boolean; file: { name: string; bytes: Uint8Array } };

export async function uploadDocument(tx: Tx, actor: Actor, input: UploadInput) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const [folder] = await tx<{ id: string; name: string; access: unknown }[]>`select id, name, access from document_folders where id = ${input.folderId}`;
  if (!folder) throw new AppError("not_found", "Folder not found.", "folderId");
  const v = validateUpload({ name: input.file.name, size: input.file.bytes.byteLength, head: input.file.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "file");
  const title = (input.title.trim() || v.name.replace(/\.[^.]+$/, "")).slice(0, 160);
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: input.file.bytes, ext: v.name.split(".").pop() ?? "" });
  const requiresAck = input.requiresAck || input.blockUntilAck;   // blocking implies acknowledgement
  const [d] = await tx<{ id: string }[]>`
    insert into org_documents (tenant_id, folder_id, title, description, file_id, requires_ack, block_portal_until_ack)
    values (${actor.tenant.id}, ${folder.id}, ${title}, ${input.description?.trim() || null}, ${fileId}, ${requiresAck}, ${input.blockUntilAck}) returning id`;
  if (requiresAck) {
    const people = await tx<{ id: string }[]>`select e.id from employees e where ${audienceWhere(tx, parseAccess(folder.access))} and e.id <> ${actor.employeeId}`;
    for (const p of people) await notifyEmployee(tx, actor.tenant.id, p.id, "document.ack", "Please read and acknowledge", title, "/org/documents");
  }
  return { id: d.id, fileId };
}

export async function updateDocument(tx: Tx, actor: Actor, id: string, input: { title: string; description?: string | null; folderId: string; requiresAck: boolean; blockUntilAck: boolean }) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new AppError("invalid", "Give the document a title.", "title");
  const [folder] = await tx<{ id: string }[]>`select id from document_folders where id = ${input.folderId}`;
  if (!folder) throw new AppError("not_found", "Folder not found.", "folderId");
  const r = await tx`update org_documents set title = ${title}, description = ${input.description?.trim() || null}, folder_id = ${folder.id},
                     requires_ack = ${input.requiresAck || input.blockUntilAck}, block_portal_until_ack = ${input.blockUntilAck} where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Document not found.");
}

/** Deletes the document and its file row; returns the storage key so the caller can remove the bytes after commit. */
export async function deleteDocument(tx: Tx, actor: Actor, id: string) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const [d] = await tx<{ file_id: string }[]>`delete from org_documents where id = ${id} returning file_id`;
  if (!d) throw new AppError("not_found", "Document not found.");
  const [f] = await tx<{ storage_key: string }[]>`delete from files where id = ${d.file_id} and not exists (select 1 from org_documents where file_id = ${d.file_id}) returning storage_key`;
  return { storageKey: f?.storage_key ?? null };
}

/** Is this document in a folder the actor can see? */
async function visibleDoc(tx: Tx, actor: Actor, documentId: string) {
  const [d] = await tx<{ id: string; title: string; requires_ack: boolean; access: unknown }[]>`
    select d.id, d.title, d.requires_ack, f.access from org_documents d join document_folders f on f.id = d.folder_id where d.id = ${documentId}`;
  if (!d) return null;
  if (canManageDocs(actor)) return d;
  return canSeeFolder(parseAccess(d.access), await me(tx, actor.employeeId)) ? d : null;
}

/** Recorded when someone opens the file (first time only). */
export async function markViewed(tx: Tx, actor: Actor, documentId: string) {
  if (!(await visibleDoc(tx, actor, documentId))) return;
  await tx`insert into document_acks (tenant_id, document_id, employee_id, viewed_at) values (${actor.tenant.id}, ${documentId}, ${actor.employeeId}, now())
           on conflict (document_id, employee_id) do update set viewed_at = coalesce(document_acks.viewed_at, excluded.viewed_at)`;
}

/** "I have read and understood this." Idempotent: the first acknowledgement time is kept. */
export async function acknowledge(tx: Tx, actor: Actor, documentId: string) {
  const d = await visibleDoc(tx, actor, documentId);
  if (!d) throw new AppError("not_found", "Document not found.");
  if (!d.requires_ack) throw new AppError("invalid", "This document doesn't need an acknowledgement.");
  await tx`insert into document_acks (tenant_id, document_id, employee_id, viewed_at, acknowledged_at) values (${actor.tenant.id}, ${documentId}, ${actor.employeeId}, now(), now())
           on conflict (document_id, employee_id) do update set viewed_at = coalesce(document_acks.viewed_at, now()), acknowledged_at = coalesce(document_acks.acknowledged_at, now())`;
}

export type PendingAck = { id: string; title: string; description: string | null; file_id: string; file_name: string; mime: string; folder: string; blocking: boolean; viewed: boolean };

/** Documents the actor still has to acknowledge (blocking ones first). */
export async function pendingAcks(tx: Tx, actor: Actor): Promise<PendingAck[]> {
  const p = await me(tx, actor.employeeId);
  if (p.status === "relieved") return [];
  const rows = await tx<(PendingAck & { access: unknown })[]>`
    select d.id, d.title, d.description, d.file_id, fl.name as file_name, fl.mime, f.name as folder, d.block_portal_until_ack as blocking, (a.viewed_at is not null) as viewed, f.access
    from org_documents d join document_folders f on f.id = d.folder_id join files fl on fl.id = d.file_id
    left join document_acks a on a.document_id = d.id and a.employee_id = ${actor.employeeId}
    where d.requires_ack and a.acknowledged_at is null order by d.block_portal_until_ack desc, d.created_at`;
  return rows.filter((r) => canSeeFolder(parseAccess(r.access), p)).map((r) => ({ id: r.id, title: r.title, description: r.description, file_id: r.file_id, file_name: r.file_name, mime: r.mime, folder: r.folder, blocking: r.blocking, viewed: r.viewed }));
}

export type TrackingRow = { employee_id: string; name: string; department: string | null; viewed_at: Date | null; acknowledged_at: Date | null };

/** HR: who in the audience has viewed / acknowledged a document. */
export async function tracking(tx: Tx, actor: Actor, documentId: string) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const [d] = await tx<{ title: string; requires_ack: boolean; access: unknown }[]>`
    select d.title, d.requires_ack, f.access from org_documents d join document_folders f on f.id = d.folder_id where d.id = ${documentId}`;
  if (!d) throw new AppError("not_found", "Document not found.");
  const rows = await tx<TrackingRow[]>`
    select e.id as employee_id, e.display_name as name, dp.name as department, a.viewed_at, a.acknowledged_at
    from employees e left join departments dp on dp.id = e.department_id
    left join document_acks a on a.document_id = ${documentId} and a.employee_id = e.id
    where ${audienceWhere(tx, parseAccess(d.access))}
    order by a.acknowledged_at is not null, a.viewed_at is not null, e.display_name`;
  return { title: d.title, requiresAck: d.requires_ack, rows };
}

// ---------- the person's own documents (profile tab) ----------
async function personAccess(tx: Tx, actor: Actor, employeeId: string) {
  const [p] = await tx<(Placement & { manager_id: string | null })[]>`select department_id, location_id, legal_entity_id, business_unit_id, manager_id from employees where id = ${employeeId}`;
  if (!p) return { read: false, manage: false };
  const manage = canFor(actor, DOCS, p) || canFor(actor, "employees.write", p);
  const read = manage || actor.employeeId === employeeId || canFor(actor, "employees.read", p);
  return { read, manage };
}

export type PersonDoc = { id: string; category: string; doc_type: string; number: string | null; status: string; file_id: string; file_name: string; mime: string; size_bytes: number; created_at: Date; expiry_date: string | null };

export async function personDocuments(tx: Tx, actor: Actor, employeeId: string) {
  const acc = await personAccess(tx, actor, employeeId);
  if (!acc.read) return null;
  const docs = await tx<(Omit<PersonDoc, "size_bytes"> & { size_bytes: bigint | number })[]>`
    select d.id, d.category, d.doc_type, d.number, d.status, d.file_id, f.name as file_name, f.mime, f.size_bytes, d.created_at, d.expiry_date::text
    from employee_documents d join files f on f.id = d.file_id where d.employee_id = ${employeeId} order by d.category = 'letter' desc, d.created_at desc`;
  return { docs: docs.map((d) => ({ ...d, size_bytes: Number(d.size_bytes) })), canManage: acc.manage, isSelf: actor.employeeId === employeeId };
}

const CATEGORIES = ["identity", "education", "experience", "other"] as const;
export async function uploadPersonDocument(tx: Tx, actor: Actor, employeeId: string, input: { category: string; docType: string; number?: string | null; file: { name: string; bytes: Uint8Array } }) {
  const acc = await personAccess(tx, actor, employeeId);
  if (!acc.manage && actor.employeeId !== employeeId) throw new AppError("forbidden", "You can't add documents for this person.");
  if (!(CATEGORIES as readonly string[]).includes(input.category)) throw new AppError("invalid", "Pick a category.", "category");
  const docType = input.docType.trim().slice(0, 80);
  if (!docType) throw new AppError("invalid", "Say what this document is, e.g. PAN card.", "docType");
  const v = validateUpload({ name: input.file.name, size: input.file.bytes.byteLength, head: input.file.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "file");
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: input.file.bytes, ext: v.name.split(".").pop() ?? "" });
  const [d] = await tx<{ id: string }[]>`
    insert into employee_documents (tenant_id, employee_id, category, doc_type, number, file_id, status, verified_by, verified_at)
    values (${actor.tenant.id}, ${employeeId}, ${input.category}, ${docType}, ${input.number?.trim() || null}, ${fileId},
            ${acc.manage ? "verified" : "pending"}, ${acc.manage ? actor.userId : null}, ${acc.manage ? tx`now()` : null}) returning id`;
  return d;
}

/** People can remove their own unverified uploads; HR can remove anything except issued letters. */
export async function deletePersonDocument(tx: Tx, actor: Actor, id: string) {
  const [d] = await tx<{ employee_id: string; category: string; status: string; file_id: string }[]>`select employee_id, category, status, file_id from employee_documents where id = ${id}`;
  if (!d) throw new AppError("not_found", "Document not found.");
  const acc = await personAccess(tx, actor, d.employee_id);
  if (d.category === "letter") throw new AppError("invalid", "Issued letters are kept on record and can't be deleted.");
  if (!acc.manage && !(actor.employeeId === d.employee_id && d.status === "pending")) throw new AppError("forbidden", "You can't delete this document.");
  await tx`delete from employee_documents where id = ${id}`;
  const [f] = await tx<{ storage_key: string }[]>`delete from files where id = ${d.file_id} returning storage_key`;
  return { storageKey: f?.storage_key ?? null };
}

// ---------- file access (download route) ----------
/**
 * May the actor open this file? Org documents: anyone who can see the folder. Personal documents and letters:
 * the person, HR in scope. Anything else (e.g. files from other modules) is refused here.
 */
export async function fileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; org_doc: string | null; person: string | null; selfie_of: string | null }[]>`
    select f.id, f.storage_key, f.name, f.mime,
      (select d.id from org_documents d where d.file_id = f.id limit 1) as org_doc,
      coalesce((select d.employee_id from employee_documents d where d.file_id = f.id limit 1), (select g.employee_id from generated_letters g where g.file_id = f.id limit 1)) as person,
      (select p.employee_id from punches p where p.selfie_file_id = f.id limit 1) as selfie_of
    from files f where f.id = ${fileId}`;
  if (!f) return null;
  if (f.selfie_of) {
    // a clock-in selfie: the person, their manager, and whoever may see their time (attendance / leave admins for them)
    const { canSeeTime } = await import("@/server/modules/corehr/people");
    return (await canSeeTime(tx, actor, f.selfie_of)) ? f : null;
  }
  if (f.org_doc) {
    if (!(await visibleDoc(tx, actor, f.org_doc))) return null;
    await markViewed(tx, actor, f.org_doc);
    return f;
  }
  if (f.person && (await personAccess(tx, actor, f.person)).read) return f;
  return null;
}
