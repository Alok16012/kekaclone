import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { getActiveSalary } from "@/server/modules/payroll/salary";
import { markOpenRunStale } from "@/server/modules/payrun/stale";
import { cycleStartFor } from "@/server/modules/leave/effects";
import { notify } from "@/server/modules/notifications/service";
import { canManagePolicies } from "./policies";
import {
  compOffDaysFor, compOffDelta, dayKeyOf, fmtMinutes, normalizeRules, overtimePaise, validateOvertimeRules, validatePayCode, wageOnBasis,
  type OvertimeRules, type PayCode,
} from "./overtime-rules";
import type { DayType } from "./rules";

/**
 * Overtime and shift allowances: the policies (company-wide, so attendance.admin without a scope), and the monthly
 * settlement that turns approved overtime into payroll inputs (kind 'overtime') or comp-off credits, and shifts
 * worked into shift-allowance inputs. Settlement is idempotent: re-running a month updates amounts, never duplicates.
 */

const assertPolicies = (actor: Actor | null) => { if (actor && !canManagePolicies(actor)) throw new AppError("forbidden", "You don't have access to change time settings."); };
async function audit(tx: Tx, who: Actor | { tenantId: string }, entity: string, id: string, action: string, diff: unknown) {
  const tenantId = "tenant" in who ? who.tenant.id : who.tenantId;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenantId}, ${"userId" in who ? who.userId : null}, ${entity}, ${id}, ${action}, ${tx.json(diff as never)})`;
}
async function guarded<T>(tx: Tx, fn: (sp: Tx) => Promise<T>, message: string, field?: string): Promise<T> {
  try { return (await tx.savepoint((sp) => fn(sp as unknown as Tx))) as T; }
  catch (e) { if ((e as { code?: string }).code === "23505") throw new AppError("conflict", message, field); throw e; }
}
const monthOf = (m: string) => {
  if (!/^\d{4}-\d{2}(-01)?$/.test(m)) throw new AppError("invalid", "Use a month like 2026-11.", "month");
  return `${m.slice(0, 7)}-01`;
};
export const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------- pay codes

export type PayCodeRow = { id: string; name: string; kind: PayCode["kind"]; value: number | null; used_by: number };

export async function listPayCodes(tx: Tx): Promise<PayCodeRow[]> {
  const rows = await tx<(Omit<PayCodeRow, "value" | "used_by"> & { value: string | null })[]>`select id, name, kind, value from pay_codes order by created_at, id`;
  const pols = await tx<{ rules: Partial<OvertimeRules> }[]>`select rules from overtime_policies`;
  const used = new Map<string, number>();
  for (const p of pols) for (const k of ["working", "weekly_off", "holiday"] as const) { const id = p.rules?.[k]?.pay_code_id; if (id) used.set(id, (used.get(id) ?? 0) + 1); }
  return rows.map((r) => ({ ...r, value: r.value == null ? null : Number(r.value), used_by: used.get(r.id) ?? 0 }));
}

export async function savePayCode(tx: Tx, actor: Actor, id: string | null, input: { name: string; kind: PayCode["kind"]; value: number | null }) {
  assertPolicies(actor);
  const name = input.name.trim();
  const err = validatePayCode({ ...input, name });
  if (err) throw new AppError("invalid", err);
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update pay_codes set name = ${name}, kind = ${input.kind}, value = ${input.value} where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into pay_codes (tenant_id, name, kind, value) values (${actor.tenant.id}, ${name}, ${input.kind}, ${input.value}) returning id`,
    "Another pay code already has this name.", "name");
  if (!row[0]) throw new AppError("not_found", "This pay code no longer exists.");
  await audit(tx, actor, "pay_code", row[0].id, id ? "update" : "create", { ...input, name });
  return { id: row[0].id };
}

export async function deletePayCode(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const codes = await listPayCodes(tx);
  const c = codes.find((x) => x.id === id);
  if (!c) throw new AppError("not_found", "This pay code no longer exists.");
  if (c.used_by) throw new AppError("conflict", "An overtime policy uses this pay code. Change the policy first.");
  await tx`delete from pay_codes where id = ${id}`;
  await audit(tx, actor, "pay_code", id, "delete", { name: c.name });
}

// ---------------------------------------------------------------- overtime policies

export type OvertimePolicyRow = { id: string; name: string; rules: OvertimeRules; people: number };

export async function listOvertimePolicies(tx: Tx): Promise<OvertimePolicyRow[]> {
  const rows = await tx<{ id: string; name: string; rules: Partial<OvertimeRules>; people: number }[]>`
    select p.id, p.name, p.rules, (select count(*)::int from employees e where e.overtime_policy_id = p.id and e.status <> 'relieved') as people
    from overtime_policies p order by p.created_at, p.id`;
  return rows.map((r) => ({ ...r, rules: normalizeRules(r.rules) }));
}

export async function saveOvertimePolicy(tx: Tx, actor: Actor, id: string | null, input: { name: string; rules: OvertimeRules }) {
  assertPolicies(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the policy a name (up to 80 characters).", "name");
  const rules = normalizeRules(input.rules);
  const err = validateOvertimeRules(rules);
  if (err) throw new AppError("invalid", err);
  const codeIds = [...new Set(["working", "weekly_off", "holiday"].map((k) => rules[k as "working"].pay_code_id).filter((x): x is string => !!x))];
  if (codeIds.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from pay_codes where id = any(${codeIds}::uuid[])`;
    if (n !== codeIds.length) throw new AppError("invalid", "One of the chosen pay codes no longer exists.");
  }
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update overtime_policies set name = ${name}, rules = ${sp.json(rules)} where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into overtime_policies (tenant_id, name, rules) values (${actor.tenant.id}, ${name}, ${sp.json(rules)}) returning id`,
    "Another overtime policy already has this name.", "name");
  if (!row[0]) throw new AppError("not_found", "This policy no longer exists.");
  await audit(tx, actor, "overtime_policy", row[0].id, id ? "update" : "create", { name, rules });
  return { id: row[0].id };
}

export async function deleteOvertimePolicy(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const [{ used }] = await tx<{ used: number }[]>`select count(*)::int as used from employees where overtime_policy_id = ${id}`;
  if (used) throw new AppError("conflict", "People are on this policy. Move them to another one (or none) first.");
  await tx`delete from overtime_policies where id = ${id}`;
  await audit(tx, actor, "overtime_policy", id, "delete", {});
}

// ---------------------------------------------------------------- shift allowance policies

export type AllowanceRow = { id: string; name: string; shift_ids: string[]; shifts: string[]; amount_paise: number; per: "day" | "shift"; component_code: string };

export async function listAllowancePolicies(tx: Tx): Promise<AllowanceRow[]> {
  const rows = await tx<(Omit<AllowanceRow, "amount_paise" | "shifts"> & { amount_paise: bigint })[]>`select id, name, shift_ids, amount_paise, per, component_code from shift_allowance_policies order by created_at, id`;
  const shifts = await tx<{ id: string; name: string }[]>`select id, name from shifts`;
  const nameOf = new Map(shifts.map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, amount_paise: Number(r.amount_paise), shifts: r.shift_ids.map((id) => nameOf.get(id) ?? "?") }));
}

export async function saveAllowancePolicy(tx: Tx, actor: Actor, id: string | null, input: { name: string; shiftIds: string[]; amountPaise: number; per: "day" | "shift"; componentCode: string }) {
  assertPolicies(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the allowance a name (up to 80 characters).", "name");
  const shiftIds = [...new Set(input.shiftIds)];
  if (!shiftIds.length) throw new AppError("invalid", "Pick at least one shift that earns this allowance.", "shiftIds");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from shifts where id = any(${shiftIds}::uuid[])`;
  if (n !== shiftIds.length) throw new AppError("invalid", "One of the chosen shifts no longer exists.");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0 || input.amountPaise > 100_000_00) throw new AppError("invalid", "Enter an amount between ₹0.01 and ₹1,00,000.", "amount");
  if (input.per !== "day" && input.per !== "shift") throw new AppError("invalid", "Per day or per shift.");
  const code = input.componentCode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) throw new AppError("invalid", "Use a salary component code like SHIFT_ALLOWANCE.", "componentCode");
  const row = id
    ? await tx<{ id: string }[]>`update shift_allowance_policies set name = ${name}, shift_ids = ${shiftIds}::uuid[], amount_paise = ${input.amountPaise}, per = ${input.per}, component_code = ${code} where id = ${id} returning id`
    : await tx<{ id: string }[]>`insert into shift_allowance_policies (tenant_id, name, shift_ids, amount_paise, per, component_code) values (${actor.tenant.id}, ${name}, ${shiftIds}::uuid[], ${input.amountPaise}, ${input.per}, ${code}) returning id`;
  if (!row[0]) throw new AppError("not_found", "This allowance no longer exists.");
  await audit(tx, actor, "shift_allowance_policy", row[0].id, id ? "update" : "create", { name, shiftIds, amountPaise: input.amountPaise, per: input.per, componentCode: code });
  return { id: row[0].id };
}

export async function deleteAllowancePolicy(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  await tx`delete from shift_allowance_policies where id = ${id}`;
  await audit(tx, actor, "shift_allowance_policy", id, "delete", {});
}

// ---------------------------------------------------------------- monthly settlement

const LOCKED = ["finalized", "payslips_released", "paid"];
async function runLocked(tx: Tx, payGroupId: string | null, month: string) {
  if (!payGroupId) return false;
  const [r] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${payGroupId} and period_month = ${month} and status <> 'rolled_back' limit 1`;
  return !!r && LOCKED.includes(r.status);
}

export type SettleLine = { employeeId: string; name: string; minutes: number; mode: "pay" | "comp_off" | "none" | "mixed"; amountPaise: number; compOffDays: number; result: "updated" | "unchanged" | "skipped"; why?: string };

type Emp = { id: string; display_name: string; pay_group_id: string | null; overtime_policy_id: string | null };

/**
 * Settle one month's overtime for everyone on an overtime policy (or the given people). Pay-mode days become one
 * payroll input per person (kind 'overtime', amount from the pay code × hourly wage); comp-off days credit the
 * person's comp-off leave type. A month whose payroll is already finalised is left alone.
 */
export async function settleOvertime(tx: Tx, tenantId: string, monthInput: string, actor: Actor | null, opts: { employeeIds?: string[] } = {}) {
  assertPolicies(actor);
  const month = monthOf(monthInput);
  if (month > todayIn().slice(0, 8) + "01") throw new AppError("invalid", "That month hasn't started yet.", "month");
  const monthEnd = addDaysISO(addDaysISO(month, 32).slice(0, 8) + "01", -1);
  const people = await tx<Emp[]>`
    select id, display_name, pay_group_id, overtime_policy_id from employees
    where overtime_policy_id is not null and joining_date <= ${monthEnd} and (exit_date is null or exit_date >= ${month})
      ${opts.employeeIds?.length ? tx`and id = any(${opts.employeeIds}::uuid[])` : tx``} order by display_name`;
  const policies = new Map((await listOvertimePolicies(tx)).map((p) => [p.id, p]));
  const codes = new Map((await listPayCodes(tx)).map((c) => [c.id, c]));
  const earningCodes = new Set((await tx<{ code: string }[]>`select code from salary_components where kind = 'earning'`).map((c) => c.code));
  const lines: SettleLine[] = [];

  for (const p of people) {
    const policy = p.overtime_policy_id ? policies.get(p.overtime_policy_id) : null;
    if (!policy) continue;
    const rules = policy.rules;
    const days = await tx<{ date: string; day_type: DayType; overtime_minutes: number }[]>`
      select date::text, day_type, overtime_minutes from attendance_days where employee_id = ${p.id} and date between ${month} and ${monthEnd} and overtime_minutes > 0 order by date`;
    const minutes = days.reduce((s, d) => s + d.overtime_minutes, 0);
    let payMinutes = 0, compMinutes = 0, compDays = 0, amount = 0;
    let hourly: number | null = null;
    const perDay: { date: string; minutes: number; mode: string; paise: number; compOff: number }[] = [];
    for (const d of days) {
      const rule = rules[dayKeyOf(d.day_type)];
      if (!rule.enabled) continue;
      if (rule.mode === "comp_off") {
        const c = compOffDaysFor(d.overtime_minutes, rules.comp_off);
        compMinutes += d.overtime_minutes; compDays += c;
        perDay.push({ date: d.date, minutes: d.overtime_minutes, mode: "comp_off", paise: 0, compOff: c });
      } else {
        if (hourly == null) {
          const sal = await getActiveSalary(tx, p.id, monthEnd);
          hourly = sal ? Math.round(wageOnBasis(sal.breakup, rules.wage_basis, earningCodes) / rules.hours_per_month) : 0;
        }
        const code = rule.pay_code_id ? codes.get(rule.pay_code_id) : null;
        const paise = code ? overtimePaise(d.overtime_minutes, hourly, { kind: code.kind, value: code.value }, rule.tiers) : 0;
        payMinutes += d.overtime_minutes; amount += paise;
        perDay.push({ date: d.date, minutes: d.overtime_minutes, mode: "pay", paise, compOff: 0 });
      }
    }
    const mode: SettleLine["mode"] = payMinutes && compMinutes ? "mixed" : payMinutes ? "pay" : compMinutes ? "comp_off" : "none";
    const line: SettleLine = { employeeId: p.id, name: p.display_name, minutes, mode, amountPaise: amount, compOffDays: compDays, result: "unchanged" };
    let changed = false;

    // payroll input (one per person and month)
    const key = `${p.id}:${month}`;
    const [existing] = await tx<{ id: string; amount_paise: bigint; pay_group_id: string; days: string | null }[]>`
      select id, amount_paise, pay_group_id, days from payroll_inputs where kind = 'overtime' and source_ref->>'overtime_key' = ${key}`;
    let inputId: string | null = existing?.id ?? null;
    if (amount > 0 && !p.pay_group_id) { line.result = "skipped"; line.why = "not in a pay group"; }
    else if (existing && await runLocked(tx, existing.pay_group_id, month)) { line.result = "skipped"; line.why = `${monthLabel(month)} payroll is finalised`; }
    else if (amount > 0 && await runLocked(tx, p.pay_group_id, month)) { line.result = "skipped"; line.why = `${monthLabel(month)} payroll is finalised`; }
    else if (amount > 0) {
      const note = `Overtime ${monthLabel(month)}: ${fmtMinutes(payMinutes)} at ${hourly ? `₹${(hourly / 100).toFixed(2)}/h` : "no wage on file"}`;
      if (!existing) {
        const [ins] = await tx<{ id: string }[]>`
          insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, amount_paise, days, source_month, source_ref, action, note, created_by)
          values (${tenantId}, ${p.pay_group_id}, ${month}, ${p.id}, 'overtime', ${amount}, ${(payMinutes / 60).toFixed(2)}, ${month}, ${tx.json({ overtime_key: key, minutes: payMinutes })}, 'pay', ${note}, ${actor?.userId ?? null}) returning id`;
        inputId = ins.id; changed = true;
      } else if (Number(existing.amount_paise) !== amount || existing.pay_group_id !== p.pay_group_id) {
        await tx`update payroll_inputs set pay_group_id = ${p.pay_group_id}, amount_paise = ${amount}, days = ${(payMinutes / 60).toFixed(2)}, source_ref = ${tx.json({ overtime_key: key, minutes: payMinutes })}, note = ${note} where id = ${existing.id}`;
        if (existing.pay_group_id !== p.pay_group_id) await markOpenRunStale(tx, existing.pay_group_id, month);
        changed = true;
      }
      if (changed) await markOpenRunStale(tx, p.pay_group_id, month);
    } else if (existing) {
      await tx`delete from payroll_inputs where id = ${existing.id}`;
      await markOpenRunStale(tx, existing.pay_group_id, month);
      inputId = null; changed = true;
    }

    // comp-off credit (delta against what this month already posted)
    if (line.result !== "skipped" || compDays > 0) {
      const [t] = await tx<{ id: string }[]>`
        select t.id from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id join leave_types t on t.id = r.leave_type_id and t.kind = 'comp_off'
        where e.id = ${p.id} order by t.created_at limit 1`;
      if (t) {
        const [posted] = await tx<{ days: string; entries: number }[]>`
          select coalesce(sum(amount), 0) as days, count(*)::int as entries from leave_ledger
          where employee_id = ${p.id} and kind = 'comp_off_credit' and ref_type = 'overtime_month' and idempotency_key like ${`ot:${p.id}:${month}:%`}`;
        const delta = compOffDelta(p.id, month, Number(posted.days), compDays, posted.entries);
        if (delta) {
          const cycle = await cycleStartFor(tx, p.id, monthEnd);
          await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, note, idempotency_key, created_by)
                   values (${tenantId}, ${p.id}, ${t.id}, ${cycle}, ${monthEnd < todayIn() ? monthEnd : todayIn()}, 'comp_off_credit', ${delta.amount}, 'overtime_month',
                           ${`Overtime in ${monthLabel(month)}: ${fmtMinutes(compMinutes)}`}, ${delta.key}, ${actor?.userId ?? null})
                   on conflict (tenant_id, idempotency_key) do nothing`;
          changed = true;
        }
      } else if (compDays > 0) { line.why = line.why ?? "no comp-off leave type in their plan"; }
    }

    if (line.result !== "skipped") {
      await tx`insert into overtime_settlements (tenant_id, employee_id, month, policy_id, minutes, mode, amount_paise, comp_off_days, payroll_input_id, detail, settled_by)
               values (${tenantId}, ${p.id}, ${month}, ${policy.id}, ${minutes}, ${mode === "mixed" ? "pay" : mode}, ${amount}, ${compDays}, ${inputId}, ${tx.json({ days: perDay, hourly })}, ${actor?.userId ?? null})
               on conflict (employee_id, month) do update set policy_id = excluded.policy_id, minutes = excluded.minutes, mode = excluded.mode, amount_paise = excluded.amount_paise,
                 comp_off_days = excluded.comp_off_days, payroll_input_id = excluded.payroll_input_id, detail = excluded.detail, settled_by = excluded.settled_by`;
      if (changed) {
        line.result = "updated";
        const what = [amount > 0 ? `₹${(amount / 100).toLocaleString("en-IN")} with ${monthLabel(month)} payroll` : null, compDays > 0 ? `${compDays} ${compDays === 1 ? "day" : "days"} of comp-off` : null].filter(Boolean).join(" and ");
        if (what) await notify(tx, tenantId, [p.id], "attendance.overtime", "Your overtime was settled", `${fmtMinutes(minutes)} of overtime in ${monthLabel(month)}: ${what}.`, "/me/attendance");
      }
    }
    lines.push(line);
  }
  await audit(tx, actor ?? { tenantId }, "overtime_settlement", tenantId, "settle", { month, people: lines.length, updated: lines.filter((l) => l.result === "updated").length });
  return { month, lines };
}

export type AllowanceLine = { policy: string; employeeId: string; name: string; days: number; amountPaise: number; result: "updated" | "unchanged" | "skipped"; why?: string };

/** Shift allowance for a month: days worked on each policy's shifts × the amount, as payroll inputs (kind 'shift_allowance'). Idempotent. */
export async function settleShiftAllowance(tx: Tx, tenantId: string, monthInput: string, actor: Actor | null) {
  assertPolicies(actor);
  const month = monthOf(monthInput);
  if (month > todayIn().slice(0, 8) + "01") throw new AppError("invalid", "That month hasn't started yet.", "month");
  const monthEnd = addDaysISO(addDaysISO(month, 32).slice(0, 8) + "01", -1);
  const policies = await listAllowancePolicies(tx);
  const lines: AllowanceLine[] = [];
  for (const pol of policies) {
    const [comp] = await tx<{ id: string }[]>`select id from salary_components where code = ${pol.component_code}`;
    const rows = await tx<{ employee_id: string; name: string; pay_group_id: string | null; days: number }[]>`
      select a.employee_id, e.display_name as name, e.pay_group_id, count(*)::int as days
      from attendance_days a join employees e on e.id = a.employee_id
      where a.date between ${month} and ${monthEnd} and a.shift_id = any(${pol.shift_ids}::uuid[]) and a.status in ('present','wfh','on_duty','half_day','half_leave')
      group by a.employee_id, e.display_name, e.pay_group_id order by e.display_name`;
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.employee_id);
      const key = `${pol.id}:${r.employee_id}:${month}`;
      const amount = r.days * pol.amount_paise;
      const line: AllowanceLine = { policy: pol.name, employeeId: r.employee_id, name: r.name, days: r.days, amountPaise: amount, result: "unchanged" };
      const [existing] = await tx<{ id: string; amount_paise: bigint; pay_group_id: string }[]>`select id, amount_paise, pay_group_id from payroll_inputs where kind = 'shift_allowance' and source_ref->>'shift_allowance_key' = ${key}`;
      if (!r.pay_group_id) { line.result = "skipped"; line.why = "not in a pay group"; }
      else if (await runLocked(tx, existing?.pay_group_id ?? r.pay_group_id, month)) { line.result = "skipped"; line.why = `${monthLabel(month)} payroll is finalised`; }
      else if (!existing) {
        await tx`insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, component_id, amount_paise, days, source_month, source_ref, action, note, created_by)
                 values (${tenantId}, ${r.pay_group_id}, ${month}, ${r.employee_id}, 'shift_allowance', ${comp?.id ?? null}, ${amount}, ${r.days}, ${month}, ${tx.json({ shift_allowance_key: key, policy_id: pol.id })}, 'pay',
                         ${`${pol.name}: ${r.days} ${r.days === 1 ? "day" : "days"} in ${monthLabel(month)}`}, ${actor?.userId ?? null})`;
        await markOpenRunStale(tx, r.pay_group_id, month);
        line.result = "updated";
      } else if (Number(existing.amount_paise) !== amount || existing.pay_group_id !== r.pay_group_id) {
        await tx`update payroll_inputs set pay_group_id = ${r.pay_group_id}, amount_paise = ${amount}, days = ${r.days}, component_id = ${comp?.id ?? null}, note = ${`${pol.name}: ${r.days} ${r.days === 1 ? "day" : "days"} in ${monthLabel(month)}`} where id = ${existing.id}`;
        await markOpenRunStale(tx, r.pay_group_id, month);
        if (existing.pay_group_id !== r.pay_group_id) await markOpenRunStale(tx, existing.pay_group_id, month);
        line.result = "updated";
      }
      lines.push(line);
    }
    // people who no longer worked those shifts this month (e.g. days re-processed): remove their input unless locked
    const stale = await tx<{ id: string; employee_id: string; pay_group_id: string }[]>`
      select id, employee_id, pay_group_id from payroll_inputs where kind = 'shift_allowance' and source_ref->>'policy_id' = ${pol.id} and period_month = ${month}
        ${seen.size ? tx`and employee_id <> all(${[...seen]}::uuid[])` : tx``}`;
    for (const s of stale) {
      if (await runLocked(tx, s.pay_group_id, month)) continue;
      await tx`delete from payroll_inputs where id = ${s.id}`;
      await markOpenRunStale(tx, s.pay_group_id, month);
    }
  }
  await audit(tx, actor ?? { tenantId }, "shift_allowance_settlement", tenantId, "settle", { month, lines: lines.length });
  return { month, lines };
}

export type MonthOvertimeRow = { employeeId: string; name: string; policy: string | null; minutes: number; pending: number; settled: { minutes: number; mode: string; amountPaise: number; compOffDays: number; at: string } | null };

/** The month at a glance for the admin page: overtime minutes recorded per person, pending requests, and the last settlement. */
export async function overtimeMonth(tx: Tx, monthInput: string): Promise<MonthOvertimeRow[]> {
  const month = monthOf(monthInput);
  const monthEnd = addDaysISO(addDaysISO(month, 32).slice(0, 8) + "01", -1);
  const rows = await tx<{ employee_id: string; name: string; policy: string | null; minutes: number; pending: number; s_minutes: number | null; s_mode: string | null; s_amount: bigint | null; s_days: string | null; s_at: Date | null }[]>`
    select e.id as employee_id, e.display_name as name, p.name as policy,
      coalesce((select sum(a.overtime_minutes)::int from attendance_days a where a.employee_id = e.id and a.date between ${month} and ${monthEnd}), 0) as minutes,
      (select count(*)::int from attendance_requests r where r.employee_id = e.id and r.kind = 'overtime' and r.status = 'pending' and r.from_date between ${month} and ${monthEnd}) as pending,
      s.minutes as s_minutes, s.mode as s_mode, s.amount_paise as s_amount, s.comp_off_days as s_days, s.updated_at as s_at
    from employees e left join overtime_policies p on p.id = e.overtime_policy_id
    left join overtime_settlements s on s.employee_id = e.id and s.month = ${month}
    where e.status <> 'relieved' and (e.overtime_policy_id is not null or s.id is not null)
    order by e.display_name`;
  return rows.map((r) => ({
    employeeId: r.employee_id, name: r.name, policy: r.policy, minutes: r.minutes, pending: r.pending,
    settled: r.s_at ? { minutes: r.s_minutes ?? 0, mode: r.s_mode ?? "none", amountPaise: Number(r.s_amount ?? 0), compOffDays: Number(r.s_days ?? 0), at: r.s_at.toISOString() } : null,
  }));
}
