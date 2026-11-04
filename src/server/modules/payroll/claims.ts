import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { cancelApproval, startApproval, timeline } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import { fyEnd, fyLabel, fyStartOf, inr } from "@/server/modules/tax/rules";
import { todayIn } from "@/lib/dates";
import { canPayrollFor, hasAnyPayrollAdmin, placementOf } from "./access";
import { getActiveSalary } from "./salary";
import { onComponentClaimDecided } from "./effects";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
export const MAX_BILLS = 5;
const BILL_EXTS = new Set(["pdf", "png", "jpg", "jpeg"]);
const extOf = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
export type Upload = { name: string; bytes: Uint8Array };

export type ClaimableComponent = { id: string; code: string; name: string; monthlyPaise: number; limitPaise: number; usedPaise: number; remainingPaise: number; taxable: boolean };

/**
 * Reimbursable components the person can claim against this year: those marked reimbursable on their current salary
 * (or with an annual limit of their own). The annual limit is the lower of the component's cap and a year of it in
 * their salary; what's already approved or paid this year is used up.
 */
export async function claimableComponents(tx: Tx, employeeId: string, fyStart: string, asOf = todayIn()): Promise<ClaimableComponent[]> {
  const sal = await getActiveSalary(tx, employeeId, asOf > fyEnd(fyStart) ? fyEnd(fyStart) : asOf);
  const comps = await tx<{ id: string; code: string; name: string; annual_max_paise: bigint | null; is_taxable: boolean }[]>`
    select id, code, name, annual_max_paise, is_taxable from salary_components where kind = 'reimbursable' order by name`;
  const used = await tx<{ component_id: string; used: string }[]>`
    select component_id, coalesce(sum(coalesce(allowed_paise, amount_paise)), 0)::text as used from component_claims
    where employee_id = ${employeeId} and fy_start = ${fyStart} and status in ('approved','paid') group by component_id`;
  return comps.map((c) => {
    const monthly = sal?.breakup[c.code] ?? 0;
    const fromSalary = monthly * 12, cap = c.annual_max_paise == null ? null : N(c.annual_max_paise);
    const limit = cap == null ? fromSalary : fromSalary > 0 ? Math.min(cap, fromSalary) : cap;
    const u = N(used.find((x) => x.component_id === c.id)?.used);
    return { id: c.id, code: c.code, name: c.name, monthlyPaise: monthly, limitPaise: limit, usedPaise: u, remainingPaise: Math.max(0, limit - u), taxable: c.is_taxable };
  }).filter((c) => c.limitPaise > 0);
}

export type ClaimRow = {
  id: string; componentId: string; component: string; code: string; fyStart: string; claimMonth: string; amountPaise: number; allowedPaise: number | null; note: string | null;
  status: "submitted" | "approved" | "rejected" | "paid" | "withdrawn"; bills: { id: string; name: string }[]; createdAt: string; decidedAt: string | null; payrollMonth: string | null;
  employeeId: string; employee: string; employeeNumber: string | null; waitingOn: string | null;
};
type RawClaim = { id: string; component_id: string; component: string; code: string; fy_start: string; claim_month: string; amount_paise: bigint; allowed_paise: bigint | null; note: string | null; status: ClaimRow["status"]; bill_file_ids: string[]; created_at: Date; decided_at: Date | null; payroll_month: string | null; employee_id: string; employee: string; employee_number: string | null; waiting_on: string | null };
const SELECT = (tx: Tx) => tx`
  select c.id, c.component_id, sc.name as component, sc.code, c.fy_start::text, c.claim_month::text, c.amount_paise, c.allowed_paise, c.note, c.status, c.bill_file_ids, c.created_at, c.decided_at,
    (select i.period_month::text from payroll_inputs i where i.id = c.payroll_input_id) as payroll_month, c.employee_id, e.display_name as employee, e.employee_number,
    (select a.display_name from approval_requests r join approval_steps s on s.request_id = r.id and s.status = 'pending' join employees a on a.id = s.approver_employee_id
      where r.entity_type = 'component_claim' and r.entity_id = c.id and r.status = 'pending' limit 1) as waiting_on
  from component_claims c join salary_components sc on sc.id = c.component_id join employees e on e.id = c.employee_id`;

async function toRows(tx: Tx, raw: RawClaim[]): Promise<ClaimRow[]> {
  const ids = raw.flatMap((r) => r.bill_file_ids);
  const names = new Map((ids.length ? await tx<{ id: string; name: string }[]>`select id, name from files where id = any(${ids}::uuid[])` : []).map((f) => [f.id, f.name]));
  return raw.map((r) => ({
    id: r.id, componentId: r.component_id, component: r.component, code: r.code, fyStart: r.fy_start, claimMonth: r.claim_month, amountPaise: N(r.amount_paise), allowedPaise: r.allowed_paise == null ? null : N(r.allowed_paise),
    note: r.note, status: r.status, bills: r.bill_file_ids.map((id) => ({ id, name: names.get(id) ?? "Bill" })), createdAt: r.created_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null,
    payrollMonth: r.payroll_month, employeeId: r.employee_id, employee: r.employee, employeeNumber: r.employee_number, waitingOn: r.waiting_on,
  }));
}

/** The person's own claims for the year and what they may still claim. */
export async function myClaims(tx: Tx, actor: Actor, fyStart: string, today = todayIn()) {
  if (!/^\d{4}-04-01$/.test(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  const [components, claims] = await Promise.all([
    claimableComponents(tx, actor.employeeId, fyStart, today),
    tx<RawClaim[]>`${SELECT(tx)} where c.employee_id = ${actor.employeeId} and c.fy_start = ${fyStart} order by c.created_at desc`,
  ]);
  return { fyStart, fy: fyLabel(fyStart), today, components, claims: await toRows(tx, claims) };
}

const claimInput = z.object({
  componentId: z.uuid("Pick a component"),
  claimMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, "Pick the month the bills are for"),
  amountPaise: z.number().int("Amounts are in whole paise").positive("Enter the amount on the bills").max(1_00_00_000_00, "That amount is too large"),
  note: z.string().trim().max(300, "Keep the note under 300 characters").nullable().optional(),
});

/** Send a claim with bills. It goes to the manager and then a payroll admin; the approved amount is paid, tax-free, in the next open payroll. */
export async function submitComponentClaim(tx: Tx, actor: Actor, raw: unknown, files: Upload[], today = todayIn()) {
  const p = claimInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const fyStart = fyStartOf(v.claimMonth);
  if (v.claimMonth > `${today.slice(0, 7)}-01`) throw new AppError("invalid", "Claims are for this month or an earlier one.", "claimMonth");
  if (fyStart < `${Number(fyStartOf(today).slice(0, 4)) - 1}-04-01`) throw new AppError("invalid", "That month is too far back to claim: this or last financial year only.", "claimMonth");
  const [me] = await tx<{ status: string; pay_group_id: string | null }[]>`select status, pay_group_id from employees where id = ${actor.employeeId}`;
  if (!me || me.status === "relieved") throw new AppError("forbidden", "Only current employees can send claims.");
  if (!me.pay_group_id) throw new AppError("invalid", "You aren't in a pay group yet, so claims can't be paid through payroll. Ask your payroll team.");
  const comp = (await claimableComponents(tx, actor.employeeId, fyStart, today)).find((c) => c.id === v.componentId);
  if (!comp) throw new AppError("invalid", "Pick one of the components you can claim against.", "componentId");
  if (comp.remainingPaise <= 0) throw new AppError("invalid", `You've used the whole ${inr(comp.limitPaise)} limit for ${comp.name} this year.`, "componentId");
  if (v.amountPaise > comp.remainingPaise) throw new AppError("invalid", `Up to ${inr(comp.remainingPaise)} is left for ${comp.name} this year. Claim that much or less.`, "amountPaise");
  if (!files.length) throw new AppError("invalid", "Attach at least one bill.", "bills");
  if (files.length > MAX_BILLS) throw new AppError("invalid", `Attach up to ${MAX_BILLS} bills.`, "bills");
  const ids: string[] = [];
  for (const f of files) {
    if (!BILL_EXTS.has(extOf(f.name))) throw new AppError("invalid", "Bills must be PDF, PNG or JPG files of up to 5 MB.", "bills");
    const ok = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!ok.ok) throw new AppError("invalid", ok.error, "bills");
    ids.push(await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: ok.name, mime: ok.mime, bytes: f.bytes, ext: extOf(ok.name) }));
  }
  const [c] = await tx<{ id: string }[]>`
    insert into component_claims (tenant_id, employee_id, component_id, fy_start, claim_month, amount_paise, bill_file_ids, note)
    values (${actor.tenant.id}, ${actor.employeeId}, ${v.componentId}, ${fyStart}, ${v.claimMonth}, ${v.amountPaise}, ${ids}::uuid[], ${v.note || null}) returning id`;
  await audit(tx, actor, { entityType: "component_claim", entityId: c.id, action: "claim.submit", diff: { component: comp.code, claimMonth: v.claimMonth, amountPaise: v.amountPaise, bills: ids.length } });
  const r = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "component_claim", entityId: c.id, requesterId: actor.employeeId,
    summary: `${actor.name} · ${comp.name} claim · ${inr(v.amountPaise)} · ${v.claimMonth.slice(0, 7)}` });
  if (r.status === "approved") await onComponentClaimDecided(tx, actor, c.id, "approved");
  return { id: c.id, status: r.status === "approved" ? "approved" : "submitted" };
}

/** Take back a claim nobody has decided yet. */
export async function withdrawComponentClaim(tx: Tx, actor: Actor, claimId: string) {
  const r = await tx`update component_claims set status = 'withdrawn', updated_at = now() where id = ${claimId} and employee_id = ${actor.employeeId} and status = 'submitted'`;
  if (!r.count) throw new AppError("conflict", "Only a claim waiting for approval can be withdrawn.");
  await cancelApproval(tx, "component_claim", claimId);
  await audit(tx, actor, { entityType: "component_claim", entityId: claimId, action: "claim.withdraw" });
}

/** For the inbox drawer and the desk: the claim, its bills and approval steps. Visible to the person, anyone in its chain, and payroll admins in scope. */
export async function componentClaimDetail(tx: Tx, actor: Actor, claimId: string) {
  const [raw] = await tx<RawClaim[]>`${SELECT(tx)} where c.id = ${claimId}`;
  if (!raw) return null;
  const own = raw.employee_id === actor.employeeId;
  const [step] = await tx<{ id: string }[]>`select s.id from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'component_claim' and r.entity_id = ${claimId} and s.approver_employee_id = ${actor.employeeId} limit 1`;
  const place = await placementOf(tx, raw.employee_id);
  const admin = !!place && canPayrollFor(actor, place);
  if (!own && !step && !admin) return null;
  const [claim] = await toRows(tx, [raw]);
  const remaining = (await claimableComponents(tx, raw.employee_id, raw.fy_start, raw.claim_month)).find((c) => c.id === raw.component_id);
  const steps = await timeline(tx, "component_claim", claimId);
  return { claim, limit: remaining ? { limitPaise: remaining.limitPaise, usedPaise: remaining.usedPaise, remainingPaise: remaining.remainingPaise } : null, steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })) };
}

/** Payroll desk: claims for people in scope (never decides here: approvals go through the inbox). */
export async function claimsDesk(tx: Tx, actor: Actor, fyStart: string) {
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can see reimbursable claims.");
  const raw = await tx<(RawClaim & Placement)[]>`
    select q.*, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id from (${SELECT(tx)} where c.fy_start = ${fyStart}) q join employees e on e.id = q.employee_id order by q.created_at desc`;
  return toRows(tx, raw.filter((r) => canPayrollFor(actor, r)));
}

/** A bill the actor may open: on their own claim, or on a claim they approve or administer. */
export async function claimFileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string }[]>`select id, storage_key, name, mime from files where id = ${fileId}`;
  if (!f) return null;
  const [c] = await tx<{ id: string }[]>`select id from component_claims where ${fileId}::uuid = any(bill_file_ids) limit 1`;
  if (!c) return null;
  return (await componentClaimDetail(tx, actor, c.id)) ? f : null;
}

/** Once a month is paid: claims whose input was paid on a processed line are paid; the rest go back to approved without an input. */
export async function markComponentClaimsPaid(tx: Tx, payGroupId: string, month: string, opts: { runId?: string } = {}) {
  const onPaidLine = opts.runId
    ? tx`and exists (select 1 from payroll_lines l where l.run_id = ${opts.runId} and l.employee_id = i.employee_id and l.action not in ('hold_processing','void') and l.earnings @> jsonb_build_array(jsonb_build_object('inputId', i.id::text)))`
    : tx``;
  const r = await tx`
    update component_claims c set status = 'paid', updated_at = now()
    where c.status = 'approved' and exists (select 1 from payroll_inputs i where i.id = c.payroll_input_id and i.pay_group_id = ${payGroupId} and i.period_month = ${month} and i.action = 'pay' ${onPaidLine})`;
  if (opts.runId) {
    await tx`
      update payroll_inputs i set source_ref = (i.source_ref - 'component_claim_id') || jsonb_build_object('unpaid_component_claim_id', i.source_ref->>'component_claim_id'), updated_at = now()
      from component_claims c
      where i.kind = 'component_claim' and i.pay_group_id = ${payGroupId} and i.period_month = ${month} and i.source_ref->>'component_claim_id' = c.id::text and c.status = 'approved'`;
    await tx`update component_claims c set payroll_input_id = null, updated_at = now() where c.status = 'approved' and c.payroll_input_id is not null
      and exists (select 1 from payroll_inputs i where i.id = c.payroll_input_id and i.pay_group_id = ${payGroupId} and i.period_month = ${month})`;
  }
  return r.count;
}
