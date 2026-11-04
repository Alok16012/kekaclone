import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { listMaster, type MasterRow } from "@/server/modules/settings/org";
import { proratedOpening } from "@/server/modules/leave/rules";
import { invite } from "@/server/modules/auth/flows";
import { audit } from "@/server/modules/audit/service";
import {
  checkCompany, checkLeaveBasics, checkPolicies, finish, markStep, normalize, nextStep, progress, shouldAutoOpen, showChecklist, start,
  QUOTA_TYPES, STEP_KEYS, WEEKLY_OFF_PRESETS, type CompanyInput, type PoliciesInput, type QuotaCode, type SetupState, type SetupStep, type StepStatus, type WeeklyOffPreset,
} from "./rules";

/** The wizard is for whoever owns the workspace: Global admins only. */
export const isGlobalAdmin = (actor: Actor) => actor.permissions.has("*");
function assertSetup(actor: Actor) {
  if (!isGlobalAdmin(actor)) throw new AppError("forbidden", "Only a Global admin can run company setup.");
}

async function readState(tx: Tx): Promise<SetupState> {
  const [t] = await tx<{ setup_state: unknown }[]>`select setup_state from tenants`;
  return normalize(t?.setup_state);
}
async function writeState(tx: Tx, actor: Actor, s: SetupState) {
  await tx`update tenants set setup_state = ${tx.json(s as never)}, updated_at = now() where id = ${actor.tenant.id}`;
}
const now = () => new Date().toISOString();

export type SetupSummary = { state: SetupState; progress: ReturnType<typeof progress>; next: SetupStep; autoOpen: boolean };

/** For the dashboard checklist: null when there's nothing to show to this person. */
export async function setupSummary(tx: Tx, actor: Actor): Promise<SetupSummary | null> {
  if (!isGlobalAdmin(actor)) return null;
  const state = await readState(tx);
  if (!showChecklist(state)) return null;
  return { state, progress: progress(state), next: nextStep(state), autoOpen: shouldAutoOpen(state) };
}

export type SetupData = {
  state: SetupState;
  company: { id: string | null; name: string; pan: string | null; tan: string | null; address: Record<string, string> };
  locations: MasterRow[]; departments: MasterRow[]; designations: MasterRow[]; businessUnits: MasterRow[];
  leave: { planId: string | null; yearStart: "jan" | "apr"; locked: boolean; quotas: Record<QuotaCode, number | null> };
  policies: {
    holidayList: { id: string; name: string; year: number; holidays: { id: string; name: string; date: string; is_floater: boolean }[] } | null;
    shift: { id: string; name: string; start: string; end: string } | null;
    weeklyOff: { id: string; name: string; preset: WeeklyOffPreset | null } | null;
    payGroup: { id: string; name: string; cutoffDay: number } | null;
  };
  people: { total: number; notInvited: { id: string; name: string; email: string }[]; waiting: number };
};

export async function setupData(tx: Tx, actor: Actor): Promise<SetupData> {
  assertSetup(actor);
  const state = await readState(tx);
  const [[le], locations, departments, designations, businessUnits, [plan], people] = await Promise.all([
    tx<{ id: string; name: string; pan: string | null; tan: string | null; address: Record<string, string> }[]>`select id, name, pan, tan, address from legal_entities order by created_at limit 1`,
    listMaster(tx, "locations"), listMaster(tx, "departments"), listMaster(tx, "designations"), listMaster(tx, "business_units"),
    tx<{ id: string; year_start: string; used: boolean }[]>`
      select p.id, p.year_start, exists (select 1 from leave_requests q join employees e on e.id = q.employee_id where e.leave_plan_id = p.id and q.status in ('pending','approved')) as used
      from leave_plans p order by p.is_default desc, p.created_at limit 1`,
    tx<{ id: string; name: string; email: string; user_status: string | null; invited_at: Date | null }[]>`
      select e.id, e.display_name as name, e.work_email as email, u.status as user_status, u.invited_at
      from employees e left join users u on u.id = e.user_id where e.status <> 'relieved' order by e.display_name`,
  ]);
  const quotas = Object.fromEntries(QUOTA_TYPES.map((t) => [t.code, null])) as Record<QuotaCode, number | null>;
  if (plan) {
    const rules = await tx<{ code: string; yearly_quota: string | null }[]>`
      select t.code, r.yearly_quota from leave_plan_rules r join leave_types t on t.id = r.leave_type_id where r.leave_plan_id = ${plan.id}`;
    for (const r of rules) if (r.code in quotas) quotas[r.code as QuotaCode] = r.yearly_quota == null ? null : Number(r.yearly_quota);
  }
  const year = Number(todayIn().slice(0, 4));
  const [hl] = await tx<{ id: string; name: string; year: number }[]>`select id, name, year from holiday_lists where year >= ${year} order by year, created_at limit 1`;
  const holidays = hl ? await tx<{ id: string; name: string; date: string; is_floater: boolean }[]>`select id, name, date::text, is_floater from holidays where holiday_list_id = ${hl.id} order by date` : [];
  const [shift] = await tx<{ id: string; name: string; timings: Record<string, { start: string; end: string }> }[]>`select id, name, timings from shifts order by created_at, id limit 1`;
  const [wo] = await tx<{ id: string; name: string; pattern: Record<string, unknown> }[]>`select id, name, pattern from weekly_off_policies order by created_at, id limit 1`;
  const [pg] = await tx<{ id: string; name: string; attendance_cutoff_day: number }[]>`select id, name, attendance_cutoff_day from pay_groups order by created_at limit 1`;
  const firstTiming = shift ? Object.values(shift.timings ?? {})[0] : null;
  const preset = wo ? WEEKLY_OFF_PRESETS.find((p) => JSON.stringify(p.pattern) === JSON.stringify(wo.pattern))?.key ?? null : null;
  return {
    state,
    company: le ? { id: le.id, name: le.name, pan: le.pan, tan: le.tan, address: le.address ?? {} } : { id: null, name: actor.tenant.name, pan: null, tan: null, address: {} },
    locations, departments, designations, businessUnits,
    leave: { planId: plan?.id ?? null, yearStart: plan?.year_start === "apr" ? "apr" : "jan", locked: !!plan?.used, quotas },
    policies: {
      holidayList: hl ? { ...hl, holidays } : null,
      shift: shift ? { id: shift.id, name: shift.name, start: firstTiming?.start ?? "09:30", end: firstTiming?.end ?? "18:30" } : null,
      weeklyOff: wo ? { id: wo.id, name: wo.name, preset } : null,
      payGroup: pg ? { id: pg.id, name: pg.name, cutoffDay: pg.attendance_cutoff_day } : null,
    },
    people: {
      total: people.length,
      notInvited: people.filter((p) => p.user_status === "invited" && !p.invited_at).map(({ id, name, email }) => ({ id, name, email })),
      waiting: people.filter((p) => p.user_status === "invited" && p.invited_at).length,
    },
  };
}

/** First time the wizard opens: stops the dashboard from redirecting again. Idempotent. */
export async function openSetup(tx: Tx, actor: Actor) {
  assertSetup(actor);
  const s = await readState(tx);
  if (s.status !== "pending" && s.status !== "none") return s;
  const next = start(s, now());
  await writeState(tx, actor, next);
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "setup.start" });
  return next;
}

async function mark(tx: Tx, actor: Actor, step: SetupStep, status: StepStatus) {
  const s = await readState(tx);
  if (s.status === "done") return s;     // finished setups don't change; edits happen in Settings
  const next = markStep(s, step, status, now());
  await writeState(tx, actor, next);
  if (s.steps[step]?.status !== next.steps[step]?.status) await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "setup.step", diff: { step, status: next.steps[step]!.status } });
  return next;
}

/** Done / skip for the list steps. "Done" needs at least one entry so the rest of the app has something to use. */
export async function completeStep(tx: Tx, actor: Actor, step: SetupStep, status: StepStatus) {
  assertSetup(actor);
  if (!STEP_KEYS.includes(step)) throw new AppError("invalid", "Unknown step.");
  if (status === "done") {
    if (step === "company" || step === "leave" || step === "policies") throw new AppError("invalid", "Save this step's form to complete it.");
    const need: Partial<Record<SetupStep, [string, string]>> = { locations: ["locations", "location"], departments: ["departments", "department"], designations: ["designations", "designation"], business_units: ["business_units", "business unit"] };
    const n = need[step];
    if (n) {
      const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from ${tx(n[0])}`;
      if (!c) throw new AppError("invalid", `Add at least one ${n[1]}, or skip this step for now.`);
    }
  }
  return mark(tx, actor, step, status);
}

export async function saveCompany(tx: Tx, actor: Actor, input: CompanyInput) {
  assertSetup(actor);
  const r = checkCompany(input);
  if (!r.ok) throw new AppError("invalid", r.problem.message, r.problem.field);
  const v = r.value;
  const [le] = await tx<{ id: string; name: string; pan: string | null; tan: string | null; address: Record<string, string> }[]>`select id, name, pan, tan, address from legal_entities order by created_at limit 1`;
  try {
    await tx.savepoint(async (sp) => {
      if (le) await sp`update legal_entities set name = ${v.name}, pan = ${v.pan}, tan = ${v.tan}, address = ${sp.json(v.address)}, updated_at = now() where id = ${le.id}`;
      else await sp`insert into legal_entities (tenant_id, name, pan, tan, address) values (${actor.tenant.id}, ${v.name}, ${v.pan}, ${v.tan}, ${sp.json(v.address)})`;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "Another legal entity already has this name.", "name");
    throw e;
  }
  const before: Record<string, unknown> = le ? { name: le.name, pan: le.pan, tan: le.tan, address: le.address } : {};
  const after: Record<string, unknown> = { name: v.name, pan: v.pan, tan: v.tan, address: v.address };
  const diff = Object.fromEntries(Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => [k, { old: before[k] ?? null, new: after[k] }]));
  if (Object.keys(diff).length) await audit(tx, actor, { entityType: "legal_entities", entityId: le?.id ?? null, action: le ? "update" : "create", diff: le ? diff : { name: v.name } });
  return mark(tx, actor, "company", "done");
}

/**
 * Leave year start and the three common quotas on the default plan. Opening balances already given to people
 * who haven't used or requested that leave are recalculated so they match; anyone who has keeps theirs.
 */
export async function saveLeaveBasics(tx: Tx, actor: Actor, input: { yearStart: unknown; quotas: Record<string, unknown> }) {
  assertSetup(actor);
  const r = checkLeaveBasics(input);
  if (!r.ok) throw new AppError("invalid", r.problem.message, r.problem.field);
  const v = r.value;
  const [plan] = await tx<{ id: string; year_start: string }[]>`select id, year_start from leave_plans order by is_default desc, created_at limit 1 for update`;
  if (!plan) throw new AppError("not_found", "There's no leave plan yet.");
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  if (plan.year_start !== v.yearStart) {
    const [{ used }] = await tx<{ used: boolean }[]>`select exists (select 1 from leave_requests q join employees e on e.id = q.employee_id where e.leave_plan_id = ${plan.id} and q.status in ('pending','approved')) as used`;
    if (used) throw new AppError("invalid", "People have already requested leave in this leave year, so its start month can't change now.", "yearStart");
    await tx`update leave_plans set year_start = ${v.yearStart}, updated_at = now() where id = ${plan.id}`;
    diff.year_start = { old: plan.year_start, new: v.yearStart };
  }
  for (const t of QUOTA_TYPES) {
    const [rule] = await tx<{ id: string; yearly_quota: string | null; leave_type_id: string }[]>`
      select r.id, r.yearly_quota, r.leave_type_id from leave_plan_rules r join leave_types lt on lt.id = r.leave_type_id where r.leave_plan_id = ${plan.id} and lt.code = ${t.code}`;
    if (!rule) continue;
    const old = rule.yearly_quota == null ? null : Number(rule.yearly_quota);
    if (old !== v.quotas[t.code]) {
      await tx`update leave_plan_rules set yearly_quota = ${v.quotas[t.code]}, updated_at = now() where id = ${rule.id}`;
      diff[`${t.code} quota`] = { old, new: v.quotas[t.code] };
    }
  }
  let resynced = 0, kept = 0;
  if (Object.keys(diff).length) {
    ({ resynced, kept } = await resyncOpenings(tx, actor, plan.id, v.yearStart));
    await audit(tx, actor, { entityType: "leave_plan", entityId: plan.id, action: "update", diff });
  }
  await mark(tx, actor, "leave", "done");
  return { resynced, kept };
}

async function resyncOpenings(tx: Tx, actor: Actor, planId: string, yearStart: "jan" | "apr") {
  const startMonth = yearStart === "apr" ? 4 : 1;
  const today = todayIn();
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const cycleStart = `${tm >= startMonth ? ty : ty - 1}-${String(startMonth).padStart(2, "0")}-01`;
  const rules = await tx<{ leave_type_id: string; yearly_quota: string | null }[]>`select leave_type_id, yearly_quota from leave_plan_rules where leave_plan_id = ${planId}`;
  const people = await tx<{ id: string; joining_date: string }[]>`select id, joining_date::text from employees where leave_plan_id = ${planId} and status <> 'relieved'`;
  let resynced = 0, kept = 0;
  for (const p of people) {
    let touched = false;
    for (const rl of rules) {
      const [{ busy }] = await tx<{ busy: boolean }[]>`
        select exists (select 1 from leave_ledger where employee_id = ${p.id} and leave_type_id = ${rl.leave_type_id} and kind in ('use','use_reversal','penalty'))
            or exists (select 1 from leave_requests where employee_id = ${p.id} and leave_type_id = ${rl.leave_type_id} and status in ('pending','approved')) as busy`;
      if (busy) { kept++; continue; }
      // the ledger is append-only: top up or trim with an adjustment instead of rewriting the opening entry
      const from = p.joining_date > cycleStart ? p.joining_date : cycleStart;
      const target = rl.yearly_quota == null ? 0 : proratedOpening(Number(rl.yearly_quota), from, startMonth);
      const [{ credited, openings }] = await tx<{ credited: string; openings: number }[]>`
        select coalesce(sum(amount), 0) as credited, count(*) filter (where kind = 'opening')::int as openings
        from leave_ledger where employee_id = ${p.id} and leave_type_id = ${rl.leave_type_id} and cycle_start = ${cycleStart} and kind not in ('use','use_reversal','penalty')`;
      const delta = target - Number(credited);
      if (delta === 0) continue;
      if (!openings && Number(credited) === 0) await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, note, idempotency_key, created_by)
        values (${actor.tenant.id}, ${p.id}, ${rl.leave_type_id}, ${cycleStart}, ${from}, 'opening', ${target}, 'Opening balance for the leave year',
                ${`opening:${p.id}:${rl.leave_type_id}:${cycleStart}`}, ${actor.userId})`;
      else await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, note, created_by)
        values (${actor.tenant.id}, ${p.id}, ${rl.leave_type_id}, ${cycleStart}, ${today}, 'adjust', ${delta}, 'Yearly quota changed in company setup', ${actor.userId})`;
      touched = true;
    }
    if (touched) resynced++;
  }
  return { resynced, kept };
}

/**
 * Policies: the default shift's hours (Monday to Friday, keeping any weekend timings), the default weekly-off pattern,
 * and the pay group's attendance cut-off when payroll is set up. Holidays are added one by one on the same step.
 */
export async function savePolicies(tx: Tx, actor: Actor, input: PoliciesInput) {
  assertSetup(actor);
  const r = checkPolicies(input);
  if (!r.ok) throw new AppError("invalid", r.problem.message, r.problem.field);
  const v = r.value;
  const diff: Record<string, unknown> = {};
  const [shift] = await tx<{ id: string; timings: Record<string, { start: string; end: string }> }[]>`select id, timings from shifts order by created_at, id limit 1 for update`;
  if (shift) {
    const timings = { ...(shift.timings ?? {}) };
    for (const d of ["mon", "tue", "wed", "thu", "fri"]) if (timings[d] || !Object.keys(timings).length || ["mon", "tue", "wed", "thu", "fri"].some((k) => timings[k])) timings[d] = { start: v.shiftStart, end: v.shiftEnd };
    if (JSON.stringify(timings) !== JSON.stringify(shift.timings)) { await tx`update shifts set timings = ${tx.json(timings)}, updated_at = now() where id = ${shift.id}`; diff.shift = { start: v.shiftStart, end: v.shiftEnd }; }
  } else {
    const timings = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { start: v.shiftStart, end: v.shiftEnd }]));
    await tx`insert into shifts (tenant_id, name, code, timings, break_minutes, grace_minutes, half_day_minutes) values (${actor.tenant.id}, 'General', 'GEN', ${tx.json(timings)}, 60, 15, 240)`;
    diff.shift = { start: v.shiftStart, end: v.shiftEnd, created: true };
  }
  const preset = WEEKLY_OFF_PRESETS.find((p) => p.key === v.weeklyOff)!;
  const [wo] = await tx<{ id: string; pattern: unknown }[]>`select id, pattern from weekly_off_policies order by created_at, id limit 1 for update`;
  if (wo) {
    if (JSON.stringify(wo.pattern) !== JSON.stringify(preset.pattern)) { await tx`update weekly_off_policies set name = ${preset.label}, pattern = ${tx.json(preset.pattern)}, updated_at = now() where id = ${wo.id}`; diff.weekly_off = preset.key; }
  } else {
    await tx`insert into weekly_off_policies (tenant_id, name, pattern) values (${actor.tenant.id}, ${preset.label}, ${tx.json(preset.pattern)})`;
    diff.weekly_off = preset.key;
  }
  if (v.cutoffDay != null) {
    const [pg] = await tx<{ id: string; attendance_cutoff_day: number }[]>`select id, attendance_cutoff_day from pay_groups order by created_at limit 1 for update`;
    if (pg && pg.attendance_cutoff_day !== v.cutoffDay) { await tx`update pay_groups set attendance_cutoff_day = ${v.cutoffDay}, updated_at = now() where id = ${pg.id}`; diff.cutoff_day = v.cutoffDay; }
  }
  if (Object.keys(diff).length) await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "setup.policies", diff });
  return mark(tx, actor, "policies", "done");
}

/** The holiday list the policies step edits: this year's first list, created if the company has none. */
export async function setupHolidayList(tx: Tx, actor: Actor) {
  assertSetup(actor);
  const year = Number(todayIn().slice(0, 4));
  const [hl] = await tx<{ id: string }[]>`select id from holiday_lists where year >= ${year} order by year, created_at limit 1`;
  if (hl) return hl.id;
  const [n] = await tx<{ id: string }[]>`insert into holiday_lists (tenant_id, name, year) values (${actor.tenant.id}, 'Company holidays', ${year}) returning id`;
  await tx`update locations set default_holiday_list_id = coalesce(default_holiday_list_id, ${n.id})`;
  return n.id;
}

/** Invite everyone who has never been sent an invite. */
export async function inviteEveryone(tx: Tx, actor: Actor) {
  assertSetup(actor);
  const ids = await tx<{ id: string }[]>`select e.id from employees e join users u on u.id = e.user_id where e.status <> 'relieved' and u.status = 'invited' and u.invited_at is null`;
  const r = ids.length ? await invite(tx, actor, ids.map((x) => x.id)) : { sent: 0, skipped: [] };
  await mark(tx, actor, "invite", "done");
  return r;
}

export async function finishSetup(tx: Tx, actor: Actor) {
  assertSetup(actor);
  const s = await readState(tx);
  if (s.status === "done") return s;
  const next = finish(s, now());
  await writeState(tx, actor, next);
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "setup.finish", diff: { completed: progress(next).done, of: progress(next).total } });
  return next;
}
