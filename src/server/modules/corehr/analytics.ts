import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { todayIn } from "@/lib/dates";
import { addMonths, annualisedAttrition, averageTenure, byDepartment, byReason, monthlySeries, monthKey, tenureBands, type EmploymentRecord, type GroupRow, type MonthRow } from "./analytics-rules";

export type Analytics = {
  scoped: boolean; from: string; to: string; today: string;
  headcount: { total: number; active: number; notice: number };
  months: MonthRow[]; annualised: number | null;
  departments: GroupRow[]; reasons: { reason: string; kind: string; n: number }[];
  tenure: ReturnType<typeof averageTenure>; bands: { label: string; n: number }[];
};

/**
 * Headcount and attrition over a window of months (default: the last 12), for the people the actor may see.
 * Every exit counts from its last working day; exits in progress don't count until the person has left.
 */
export async function peopleAnalytics(tx: Tx, actor: Actor, opts: { months?: number; to?: string } = {}): Promise<Analytics> {
  const grants = actor.grants ?? [];
  const sees = (g: { permissions: string[] }) => g.permissions.includes("*") || g.permissions.includes("employees.read") || g.permissions.includes("employees.write") || g.permissions.includes("reports.read");
  if (!grants.some(sees)) throw new AppError("forbidden", "People analytics is for HR and admins.");
  const today = todayIn();
  const to = opts.to && /^\d{4}-\d{2}$/.test(opts.to) ? opts.to : monthKey(today);
  const months = Math.min(36, Math.max(3, opts.months ?? 12));
  const from = addMonths(to, -(months - 1));
  const rows = await tx<(EmploymentRecord & Placement & { status: string })[]>`
    select e.id, e.joining_date::text, case when e.status = 'relieved' then e.exit_date::text else null end as exit_date, dp.name as department, e.status,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      r.name as reason, x.kind
    from employees e left join departments dp on dp.id = e.department_id
    left join exit_requests x on x.employee_id = e.id and x.status = 'exited' left join exit_reasons r on r.id = x.reason_id
    where e.status in ('active','notice','relieved')`;
  const visible = rows.filter((r) => canFor(actor, "employees.read", r) || canFor(actor, "reports.read", r) || canFor(actor, "employees.write", r));
  const scoped = !grants.some((g) => sees(g) && g.scopes.length === 0);
  const people: EmploymentRecord[] = visible.map(({ id, joining_date, exit_date, department, reason, kind }) => ({ id, joining_date, exit_date, department, reason, kind }));
  const series = monthlySeries(people, from, to);
  return {
    scoped, from, to, today,
    headcount: { total: visible.filter((r) => r.status !== "relieved").length, active: visible.filter((r) => r.status === "active").length, notice: visible.filter((r) => r.status === "notice").length },
    months: series, annualised: annualisedAttrition(series),
    departments: byDepartment(people, from, to), reasons: byReason(people, from, to),
    tenure: averageTenure(people, today, from, to), bands: tenureBands(people, today),
  };
}
