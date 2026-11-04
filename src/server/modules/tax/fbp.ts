import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { canPayrollFor, hasAnyPayrollAdmin } from "@/server/modules/payroll/access";
import { getActiveSalary } from "@/server/modules/payroll/salary";
import { todayIn } from "@/lib/dates";
import { fbpExemptPaise, fbpItems, fbpProblem, fbpWindowOpen, type FbpComponent, type FbpItem } from "./fbp-rules";
import { fyEnd, fyLabel } from "./rules";
import { settingsFor } from "./service";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
const isFy = (s: string) => /^\d{4}-04-01$/.test(s);

/** The FBP components with what the person's current salary pays for each (components not on their structure show a zero limit). */
export async function fbpComponentsFor(tx: Tx, employeeId: string, asOf: string): Promise<FbpComponent[]> {
  const comps = await tx<{ code: string; name: string; annual_max_paise: bigint | null; is_taxable: boolean }[]>`
    select code, name, annual_max_paise, is_taxable from salary_components where is_fbp and kind in ('earning','reimbursable') order by name`;
  if (!comps.length) return [];
  const sal = await getActiveSalary(tx, employeeId, asOf);
  return comps.map((c) => ({ code: c.code, name: c.name, annualMaxPaise: c.annual_max_paise == null ? null : N(c.annual_max_paise), monthlyPaise: sal?.breakup[c.code] ?? 0, taxable: c.is_taxable }));
}

type Row = { id: string; items: Record<string, number>; status: "draft" | "submitted"; submitted_at: Date | null; updated_at: Date };
const rowFor = async (tx: Tx, employeeId: string, fyStart: string) => (await tx<Row[]>`select id, items, status, submitted_at, updated_at from fbp_declarations where employee_id = ${employeeId} and fy_start = ${fyStart}`)[0] ?? null;

/** For payroll's tax inputs: the exemption the year's FBP declaration brings. Zero without a submitted declaration. */
export async function fbpFor(tx: Tx, employeeId: string, fyStart: string): Promise<{ declaredPaise: number; exemptPaise: number; items: FbpItem[]; status: "none" | "submitted" }> {
  const d = await rowFor(tx, employeeId, fyStart);
  if (!d || d.status !== "submitted") return { declaredPaise: 0, exemptPaise: 0, items: [], status: "none" };
  const items = fbpItems(d.items, await fbpComponentsFor(tx, employeeId, fyEnd(fyStart)));
  return { declaredPaise: items.reduce((t, r) => t + r.declaredPaise, 0), exemptPaise: fbpExemptPaise(items), items, status: "submitted" };
}

export type MyFbp = {
  fyStart: string; fy: string; today: string; items: FbpItem[]; status: "none" | "submitted"; submittedAt: string | null;
  exemptPaise: number; window: { open: boolean; message: string }; hasPlan: boolean;
};

/** The person's own flexible benefits for the year. */
export async function myFbp(tx: Tx, actor: Actor, fyStart: string, today = todayIn()): Promise<MyFbp> {
  if (!isFy(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  const [p] = await tx<{ pay_group_id: string | null }[]>`select pay_group_id from employees where id = ${actor.employeeId}`;
  const settings = await settingsFor(tx, p?.pay_group_id ?? null);
  const comps = await fbpComponentsFor(tx, actor.employeeId, today > fyEnd(fyStart) ? fyEnd(fyStart) : today);
  const d = await rowFor(tx, actor.employeeId, fyStart);
  const items = fbpItems(d?.items ?? {}, comps);
  return {
    fyStart, fy: fyLabel(fyStart), today, items, status: d?.status === "submitted" ? "submitted" : "none", submittedAt: d?.submitted_at?.toISOString() ?? null,
    exemptPaise: d?.status === "submitted" ? fbpExemptPaise(items) : 0, window: fbpWindowOpen(settings.fbpWindow, fyStart, today), hasPlan: comps.length > 0,
  };
}

/** Declare (or change) the year's flexible benefits: self-service, inside the FBP window, within each component's limit. Saving submits. */
export async function saveFbp(tx: Tx, actor: Actor, fyStart: string, raw: unknown, today = todayIn()) {
  if (!isFy(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  const items: Record<string, number> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, unknown>)) { if (typeof v !== "number") throw new AppError("invalid", "Amounts must be numbers in whole paise.", k); items[k] = v; }
  const [p] = await tx<{ pay_group_id: string | null; status: string }[]>`select pay_group_id, status from employees where id = ${actor.employeeId}`;
  if (!p || p.status === "relieved") throw new AppError("forbidden", "You've left the company, so flexible benefits can't change.");
  const w = fbpWindowOpen((await settingsFor(tx, p.pay_group_id)).fbpWindow, fyStart, today);
  if (!w.open) throw new AppError("invalid", w.message);
  const comps = await fbpComponentsFor(tx, actor.employeeId, today);
  if (!comps.length) throw new AppError("invalid", "Your company hasn't set up a flexible benefit plan.");
  const problem = fbpProblem(items, comps);
  if (problem) throw new AppError("invalid", problem.message, problem.code);
  const clean = Object.fromEntries(Object.entries(items).filter(([, v]) => v > 0));
  await tx`
    insert into fbp_declarations (tenant_id, employee_id, fy_start, items, status, submitted_at) values (${actor.tenant.id}, ${actor.employeeId}, ${fyStart}, ${tx.json(clean)}, 'submitted', now())
    on conflict (employee_id, fy_start) do update set items = excluded.items, status = 'submitted', submitted_at = coalesce(fbp_declarations.submitted_at, now()), updated_at = now()`;
  const rows = fbpItems(clean, comps);
  await audit(tx, actor, { entityType: "fbp_declaration", entityId: actor.employeeId, action: "fbp.declare", diff: { fyStart, items: clean, exemptPaise: fbpExemptPaise(rows) } });
  return { exemptPaise: fbpExemptPaise(rows), items: rows };
}

/** Payroll admins: everyone in scope with what they declared for the year. */
export async function fbpOverview(tx: Tx, actor: Actor, fyStart: string) {
  if (!isFy(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can see flexible benefit declarations.");
  const rows = await tx<(Placement & { id: string; display_name: string; employee_number: string | null; items: Record<string, number> | null; submitted_at: Date | null })[]>`
    select e.id, e.display_name, e.employee_number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, d.items, d.submitted_at
    from employees e left join fbp_declarations d on d.employee_id = e.id and d.fy_start = ${fyStart} and d.status = 'submitted'
    where e.status <> 'relieved' order by e.display_name`;
  return rows.filter((r) => canPayrollFor(actor, r)).map((r) => ({
    employeeId: r.id, name: r.display_name, employeeNumber: r.employee_number, submittedAt: r.submitted_at?.toISOString() ?? null,
    declaredPaise: Object.values(r.items ?? {}).reduce((t, v) => t + N(v), 0), items: r.items ?? {},
  }));
}
