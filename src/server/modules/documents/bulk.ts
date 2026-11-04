import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { saveFile, storage } from "@/server/storage";
import { MAX_BATCH, safeFileName } from "./rules";
import { DOCS } from "./service";
import { issueLetter } from "./letters";
import { buildZip } from "./zip";

/**
 * Bulk letter generation: pick people by filters, one template, a batch of PDFs. Work is split into chunks that
 * each run in their own transaction, so a 500-person batch survives a timeout or a crash: whatever is left is
 * picked up by the next call (the action continues it, and the daily job finishes any batch still queued).
 */
export { MAX_BATCH };
export type BatchFilters = { departmentIds?: string[]; locationIds?: string[]; designationIds?: string[]; legalEntityIds?: string[]; status?: "active" | "notice" | "working"; employeeIds?: string[] };
const CHUNK = 20;

export function cleanFilters(raw: unknown): BatchFilters {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500) : []);
  const status = r.status === "active" || r.status === "notice" ? r.status : "working";
  const out: BatchFilters = { status };
  for (const k of ["departmentIds", "locationIds", "designationIds", "legalEntityIds", "employeeIds"] as const) { const v = ids(r[k]); if (v.length) out[k] = v; }
  return out;
}

type Candidate = Placement & { id: string; name: string; number: string; department: string | null; designation: string | null };

/** People the filters pick, limited to those the actor may issue letters to. */
export async function recipients(tx: Tx, actor: Actor, raw: unknown): Promise<Candidate[]> {
  const f = cleanFilters(raw);
  const rows = await tx<Candidate[]>`
    select e.id, e.display_name as name, e.employee_number as number, dp.name as department, d.title as designation,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from employees e left join departments dp on dp.id = e.department_id left join designations d on d.id = e.designation_id
    where ${f.status === "active" ? tx`e.status = 'active'` : f.status === "notice" ? tx`e.status = 'notice'` : tx`e.status in ('active','notice')`}
      and (${f.departmentIds ?? null}::uuid[] is null or e.department_id = any(${f.departmentIds ?? null}::uuid[]))
      and (${f.locationIds ?? null}::uuid[] is null or e.location_id = any(${f.locationIds ?? null}::uuid[]))
      and (${f.designationIds ?? null}::uuid[] is null or e.designation_id = any(${f.designationIds ?? null}::uuid[]))
      and (${f.legalEntityIds ?? null}::uuid[] is null or e.legal_entity_id = any(${f.legalEntityIds ?? null}::uuid[]))
      and (${f.employeeIds ?? null}::uuid[] is null or e.id = any(${f.employeeIds ?? null}::uuid[]))
    order by e.display_name`;
  return rows.filter((p) => canFor(actor, DOCS, p));
}

export type BatchRow = { id: string; template_name: string; status: "queued" | "running" | "done" | "failed"; total: number; done: number; failed: number; zip_file_id: string | null; created_by: string | null; created_at: Date; finished_at: Date | null; error: string | null };

/** Create the batch and its queued items. Nothing is rendered here; call runBatch after commit. */
export async function createBatch(tx: Tx, actor: Actor, input: { templateId: string; filters: unknown }) {
  const [t] = await tx<{ id: string; name: string }[]>`select id, name from letter_templates where id = ${input.templateId} and kind <> 'offer'`;
  if (!t) throw new AppError("not_found", "Template not found.", "templateId");
  const people = await recipients(tx, actor, input.filters);
  if (!people.length) throw new AppError("invalid", "Nobody matches these filters (or you can't issue letters to them).", "filters");
  if (people.length > MAX_BATCH) throw new AppError("invalid", `A batch can cover at most ${MAX_BATCH} people. Narrow the filters.`, "filters");
  const [b] = await tx<{ id: string }[]>`
    insert into letter_batches (tenant_id, template_id, template_name, filters, status, total, created_by)
    values (${actor.tenant.id}, ${t.id}, ${t.name}, ${tx.json(cleanFilters(input.filters) as never)}, 'queued', ${people.length}, ${actor.userId}) returning id`;
  for (const p of people) await tx`insert into letter_batch_items (tenant_id, batch_id, employee_id) values (${actor.tenant.id}, ${b.id}, ${p.id})`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'letter_batch', ${b.id}, 'letters.bulk', ${tx.json({ template: t.name, people: people.length })})`;
  return { id: b.id, total: people.length };
}

/**
 * Process queued items in chunks, each in its own transaction, until the batch is finished or the time budget is
 * used up. Safe to call again at any time and from several places: the batch row is locked per chunk and an item is
 * only ever rendered once.
 */
export async function runBatch(tenantId: string, batchId: string, opts: { budgetMs?: number; now?: () => number } = {}) {
  const clock = opts.now ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? 20_000);
  let processed = 0;
  for (;;) {
    const r = await withTenant(tenantId, async (tx) => {
      const [b] = await tx<{ id: string; status: string; template_id: string | null; template_name: string; created_by: string | null }[]>`
        select id, status, template_id, template_name, created_by from letter_batches where id = ${batchId} for update skip locked`;
      if (!b) return "locked" as const;          // another worker has it, or it doesn't exist
      if (b.status === "done" || b.status === "failed") return "finished" as const;
      if (!b.template_id) { await fail(tx, b.id, "The template was deleted before the batch ran."); return "finished" as const; }
      if (b.status === "queued") await tx`update letter_batches set status = 'running', started_at = coalesce(started_at, now()) where id = ${b.id}`;
      const items = await tx<{ id: string; employee_id: string }[]>`select id, employee_id from letter_batch_items where batch_id = ${b.id} and status = 'queued' order by created_at, id limit ${CHUNK}`;
      if (!items.length) { await finish(tx, tenantId, b.id, b.created_by); return "finished" as const; }
      const [t] = await tx<{ name: string }[]>`select name from tenants`;
      for (const it of items) {
        try {
          const r = await tx.savepoint((sp) => issueLetter(sp as Tx, { tenantId, userId: b.created_by, companyName: t.name }, b.template_id!, it.employee_id, { batchId: b.id }));
          await tx`update letter_batch_items set status = 'done', letter_id = ${r.letterId}, file_id = ${r.fileId} where id = ${it.id}`;
          await tx`update letter_batches set done = done + 1 where id = ${b.id}`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await tx`update letter_batch_items set status = 'failed', error = ${msg.slice(0, 500)} where id = ${it.id}`;
          await tx`update letter_batches set failed = failed + 1 where id = ${b.id}`;
        }
        processed++;
      }
      return "more" as const;
    });
    if (r !== "more") return { processed, finished: r === "finished" };
    if (clock() > deadline) return { processed, finished: false };
  }
}

async function fail(tx: Tx, batchId: string, error: string) {
  await tx`update letter_batches set status = 'failed', error = ${error}, finished_at = now() where id = ${batchId}`;
}

/** All items handled: bundle the PDFs into one ZIP and mark the batch done. */
async function finish(tx: Tx, tenantId: string, batchId: string, userId: string | null) {
  const files = await tx<{ storage_key: string; name: string }[]>`
    select f.storage_key, f.name from letter_batch_items i join files f on f.id = i.file_id where i.batch_id = ${batchId} and i.status = 'done' order by f.name`;
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) { const bytes = await storage().get(f.storage_key); if (bytes) entries.push({ name: f.name, bytes }); }
  let zipId: string | null = null;
  if (entries.length) {
    const [b] = await tx<{ template_name: string }[]>`select template_name from letter_batches where id = ${batchId}`;
    const zip = buildZip(entries, new Date());
    if (zip.byteLength > 25 * 1024 * 1024) { await fail(tx, batchId, "The letters were issued, but the bundle is larger than 25 MB. Download them from each person's documents."); return; }
    zipId = await saveFile(tx, { tenantId, userId, name: safeFileName(`${b.template_name} - ${entries.length} letters.zip`), mime: "application/zip", bytes: zip, ext: "zip" });
  }
  await tx`update letter_batches set status = 'done', zip_file_id = ${zipId}, finished_at = now() where id = ${batchId}`;
}

/** Daily job: finish any batch left queued or running (a crashed request, a server restart). */
export async function processPendingBatches(tenantId: string, budgetMs = 60_000) {
  const ids = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`select id from letter_batches where status in ('queued','running') order by created_at`);
  let processed = 0, finished = 0;
  for (const b of ids) { const r = await runBatch(tenantId, b.id, { budgetMs }); processed += r.processed; if (r.finished) finished++; }
  return { batches: ids.length, processed, finished };
}

export async function listBatches(tx: Tx, actor: Actor): Promise<(BatchRow & { created_by_name: string | null })[]> {
  if (!(actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(DOCS))) throw new AppError("forbidden", "You don't have access to do this.");
  return tx<(BatchRow & { created_by_name: string | null })[]>`
    select b.id, b.template_name, b.status, b.total, b.done, b.failed, b.zip_file_id, b.created_by, b.created_at, b.finished_at, b.error, e.display_name as created_by_name
    from letter_batches b left join employees e on e.user_id = b.created_by order by b.created_at desc limit 50`;
}

export type BatchDetail = BatchRow & { items: { id: string; employee_id: string; name: string; number: string; status: string; file_id: string | null; error: string | null }[] };

export async function batchDetail(tx: Tx, actor: Actor, id: string): Promise<BatchDetail | null> {
  const [b] = (await listBatches(tx, actor)).filter((x) => x.id === id);
  if (!b) return null;
  const items = await tx<BatchDetail["items"]>`
    select i.id, i.employee_id, e.display_name as name, e.employee_number as number, i.status, i.file_id, i.error
    from letter_batch_items i join employees e on e.id = i.employee_id where i.batch_id = ${id} order by e.display_name`;
  return { ...b, items };
}

/** The ZIP of a batch: whoever created it, or anyone who manages documents. */
export async function batchZipFile(tx: Tx, actor: Actor, fileId: string) {
  const [b] = await tx<{ created_by: string | null; storage_key: string; name: string; mime: string }[]>`
    select b.created_by, f.storage_key, f.name, f.mime from letter_batches b join files f on f.id = b.zip_file_id where b.zip_file_id = ${fileId}`;
  if (!b) return null;
  const manage = (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(DOCS));
  return b.created_by === actor.userId || manage ? b : null;
}
