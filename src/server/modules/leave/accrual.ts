import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn, type ISODate } from "@/lib/dates";
import {
  accrualPostings, accrualSchedule, addMonthsISO, applyAccrualStops, compOffExpiries, cycleEnd, cycleStart, frequencyOf, previousCycle, round2, yearEndSplit,
  type AccrualRule, type YearEndRule,
} from "./accrual-rules";
import { assertLeaveAdmin } from "./access";
import { cycleStartFor } from "./effects";

const FREQ_NOTE = { monthly: "Monthly accrual", quarterly: "Quarterly accrual", half_yearly: "Half-yearly accrual", yearly: "Yearly accrual", upfront: "Yearly credit" } as const;

type Accruable = {
  employee_id: string; joining_date: string; exit_date: string | null; probation_end_date: string | null; probation_status: string;
  year_start: string; leave_type_id: string; yearly_quota: string; accrual: AccrualRule;
};

/**
 * Credits every accrual that is due on asOf, for the leave year containing asOf and the one before it (so a missed run
 * across the year boundary still completes last year). Idempotent: each period has a ledger idempotency key
 * accrual:{employee}:{type}:{period}, and amounts only ever top up to the schedule's running total.
 */
export async function runAccrual(tx: Tx, tenantId: string, asOf: ISODate, opts: { employeeIds?: string[]; actorUserId?: string | null } = {}) {
  const only = opts.employeeIds ?? null;
  const rows = await tx<Accruable[]>`
    select e.id as employee_id, e.joining_date::text, e.exit_date::text, e.probation_end_date::text, e.probation_status,
           p.year_start, r.leave_type_id, r.yearly_quota, r.accrual
    from employees e join leave_plans p on p.id = e.leave_plan_id
    join leave_plan_rules r on r.leave_plan_id = p.id join leave_types t on t.id = r.leave_type_id
    where r.yearly_quota is not null and t.kind <> 'comp_off'
      and (e.status <> 'relieved' or e.exit_date >= ${asOf}::date - 400)
      and (${only}::uuid[] is null or e.id = any(${only}::uuid[]))`;
  if (!rows.length) return { posted: 0, days: 0 };
  const ids = [...new Set(rows.map((r) => r.employee_id))];
  const minCycle = rows.reduce((m, r) => { const c = previousCycle(cycleStart(r.year_start, r.joining_date, asOf)); return c < m ? c : m; }, "9999-12-31");
  const sums = await tx<{ employee_id: string; leave_type_id: string; cycle_start: string; accrued: string }[]>`
    select employee_id, leave_type_id, cycle_start::text, sum(amount) as accrued from leave_ledger
    where employee_id = any(${ids}::uuid[]) and cycle_start >= ${minCycle}
      and (kind = 'accrual' or (kind = 'opening' and idempotency_key like 'opening:%'))   -- legacy joining credit counts as accrued
    group by 1, 2, 3`;
  const accrued = new Map(sums.map((s) => [`${s.employee_id}|${s.leave_type_id}|${s.cycle_start}`, Number(s.accrued)]));
  const keys = new Set((await tx<{ k: string }[]>`
    select idempotency_key as k from leave_ledger where employee_id = any(${ids}::uuid[]) and kind = 'accrual' and cycle_start >= ${minCycle}`).map((r) => r.k));
  // for the stop rules: balance (everything) and days taken (net of cancellations) per leave year
  const totals = await tx<{ employee_id: string; leave_type_id: string; cycle_start: string; balance: string; taken: string }[]>`
    select employee_id, leave_type_id, cycle_start::text, coalesce(sum(amount), 0) as balance,
           coalesce(-sum(amount) filter (where kind in ('use','use_reversal')), 0) as taken
    from leave_ledger where employee_id = any(${ids}::uuid[]) and cycle_start >= ${minCycle} group by 1, 2, 3`;
  const totalOf = new Map(totals.map((t) => [`${t.employee_id}|${t.leave_type_id}|${t.cycle_start}`, { balance: Number(t.balance), taken: Number(t.taken) }]));

  let posted = 0, days = 0;
  for (const r of rows) {
    const cur = cycleStart(r.year_start, r.joining_date, asOf);
    for (const c of [previousCycle(cur), cur]) {
      const end = cycleEnd(c);
      if (end < r.joining_date) continue;
      const schedule = accrualSchedule({
        quota: Number(r.yearly_quota), rule: r.accrual, cycleStart: c, asOf: end < asOf ? end : asOf,
        person: { joining: r.joining_date, exit: r.exit_date, probationEnd: r.probation_end_date, probationStatus: r.probation_status },
      });
      const freq = frequencyOf(r.accrual);
      const tot = totalOf.get(`${r.employee_id}|${r.leave_type_id}|${c}`) ?? { balance: 0, taken: 0 };
      const postings = accrualPostings(schedule, accrued.get(`${r.employee_id}|${r.leave_type_id}|${c}`) ?? 0);
      for (const p of applyAccrualStops(postings, { balance: tot.balance, taken: tot.taken, cap: r.accrual?.cap_balance, stopAfterTaken: r.accrual?.stop_after_days_taken })) {
        const base = `accrual:${r.employee_id}:${r.leave_type_id}:${p.periodId}`;
        // a period already credited gets a top-up (e.g. after a quota increase) under a key fixed by the new running total
        const key = keys.has(base) ? `${base}+${schedule.find((s) => s.periodId === p.periodId)!.cumulative}` : base;
        const ins = await tx`
          insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, note, idempotency_key, created_by)
          values (${tenantId}, ${r.employee_id}, ${r.leave_type_id}, ${c}, ${p.creditDate}, 'accrual', ${p.amount}, ${`${FREQ_NOTE[freq]} · ${p.periodId.slice(0, 7)}`}, ${key}, ${opts.actorUserId ?? null})
          on conflict (tenant_id, idempotency_key) do nothing returning id`;
        if (!ins.length) continue;
        posted++; days = round2(days + p.credited); keys.add(key);
        // the stop rule withholds part (or all) of it: it lapses the same day, so the ledger shows why the balance didn't move
        if (p.withheld > 0) {
          await tx`
            insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, note, idempotency_key, created_by)
            values (${tenantId}, ${r.employee_id}, ${r.leave_type_id}, ${c}, ${p.creditDate}, 'lapse', ${-p.withheld},
                    ${p.reason === "cap" ? `Not accrued: balance is at the cap of ${r.accrual.cap_balance} days` : `Not accrued: ${r.accrual.stop_after_days_taken} days already taken this leave year`},
                    ${`${key}:withheld`}, ${opts.actorUserId ?? null})
            on conflict (tenant_id, idempotency_key) do nothing`;
        }
      }
    }
  }
  return { posted, days };
}

/** Credits a new joiner's first accrual period (upfront plans: the prorated year) as of today or their joining date. */
export async function creditOnJoining(tx: Tx, tenantId: string, employeeId: string, joiningDate: ISODate, actorUserId: string | null) {
  const today = todayIn();
  return runAccrual(tx, tenantId, joiningDate > today ? joiningDate : today, { employeeIds: [employeeId], actorUserId });
}

// ---------------------------------------------------------------- year-end

export type YearEndRow = {
  employeeId: string; name: string; number: string; payGroup: boolean; typeId: string; type: string;
  cycleStart: string; cycleEnd: string; closing: number; pending: number; carry: number; encash: number; lapse: number; done: boolean;
};

async function yearEndRows(tx: Tx, planId: string, asOf: ISODate): Promise<{ plan: { id: string; name: string; year_start: string }; rows: YearEndRow[] }> {
  const [plan] = await tx<{ id: string; name: string; year_start: string }[]>`select id, name, year_start from leave_plans where id = ${planId}`;
  if (!plan) throw new AppError("not_found", "Leave plan not found.");
  const people = await tx<{ id: string; name: string; number: string; joining_date: string; pay_group_id: string | null }[]>`
    select id, display_name as name, employee_number as number, joining_date::text, pay_group_id from employees
    where leave_plan_id = ${planId} and status <> 'relieved' order by display_name`;
  const types = await tx<{ id: string; name: string; kind: string; quota: string | null; year_end: YearEndRule }[]>`
    select t.id, t.name, t.kind, r.yearly_quota as quota, r.year_end from leave_plan_rules r join leave_types t on t.id = r.leave_type_id
    where r.leave_plan_id = ${planId} and (r.yearly_quota is not null or t.kind = 'comp_off') order by t.name`;
  if (!people.length || !types.length) return { plan, rows: [] };
  const ids = people.map((p) => p.id);
  const sums = await tx<{ employee_id: string; leave_type_id: string; cycle_start: string; total: string }[]>`
    select employee_id, leave_type_id, cycle_start::text, sum(amount) as total from leave_ledger where employee_id = any(${ids}::uuid[]) group by 1, 2, 3`;
  const pend = await tx<{ employee_id: string; leave_type_id: string; from_date: string; days: string }[]>`
    select employee_id, leave_type_id, from_date::text, days from leave_requests where employee_id = any(${ids}::uuid[]) and status = 'pending'`;
  const done = new Set((await tx<{ k: string }[]>`
    select distinct split_part(idempotency_key, ':', 2) || ':' || split_part(idempotency_key, ':', 3) || ':' || split_part(idempotency_key, ':', 4) as k
    from leave_ledger where employee_id = any(${ids}::uuid[]) and idempotency_key like 'yearend:%'`).map((r) => r.k));
  const total = new Map(sums.map((s) => [`${s.employee_id}|${s.leave_type_id}|${s.cycle_start}`, Number(s.total)]));
  const rows: YearEndRow[] = [];
  for (const p of people) {
    const start = previousCycle(cycleStart(plan.year_start, p.joining_date, asOf)), end = cycleEnd(start);
    if (end < p.joining_date) continue;   // wasn't here last leave year
    for (const t of types) {
      const pending = round2(pend.filter((q) => q.employee_id === p.id && q.leave_type_id === t.id && q.from_date >= start && q.from_date <= end).reduce((s, q) => s + Number(q.days), 0));
      const closing = round2((total.get(`${p.id}|${t.id}|${start}`) ?? 0) - pending);
      const split = yearEndSplit(closing, t.kind === "comp_off" ? { carry: "all" } : t.year_end);   // comp-off carries; its own expiry decides
      rows.push({ employeeId: p.id, name: p.name, number: p.number, payGroup: !!p.pay_group_id, typeId: t.id, type: t.name, cycleStart: start, cycleEnd: end,
        closing, pending, ...split, done: done.has(`${p.id}:${t.id}:${start}`) });
    }
  }
  return { plan, rows };
}

/** Next four payroll months starting with the current one, as YYYY-MM. */
export function encashMonths(today: ISODate = todayIn()) {
  return [0, 1, 2, 3].map((i) => addMonthsISO(today.slice(0, 7) + "-01", i).slice(0, 7));
}

export async function yearEndPreview(tx: Tx, actor: Actor, planId: string, asOf: ISODate = todayIn()) {
  assertLeaveAdmin(actor);
  const r = await yearEndRows(tx, planId, asOf);
  const open = r.rows.filter((x) => !x.done);
  return { ...r, encashMonths: encashMonths(asOf),
    totals: { carry: round2(open.reduce((s, x) => s + x.carry, 0)), encash: round2(open.reduce((s, x) => s + x.encash, 0)), lapse: round2(open.reduce((s, x) => s + x.lapse, 0)), people: new Set(open.map((x) => x.employeeId)).size } };
}

/**
 * Closes last leave year for everyone on the plan: carry moves days out of the old year and into the new one, encashment
 * and lapse leave the old year. Encashed days are queued for payroll (payroll_inputs) when the person has a pay group.
 * Idempotent per person, type and leave year.
 */
export async function yearEndRun(tx: Tx, actor: Actor, planId: string, encashMonth: string, asOf: ISODate = todayIn()) {
  assertLeaveAdmin(actor);
  if (!encashMonths(asOf).includes(encashMonth)) throw new AppError("invalid", "Pick one of the next four payroll months for encashment.", "encashMonth");
  await tx`select pg_advisory_xact_lock(hashtext(${"yearend:" + planId}))`;
  const { plan, rows } = await yearEndRows(tx, planId, asOf);
  let processed = 0;
  for (const r of rows) {
    if (r.done || (r.carry === 0 && r.encash === 0 && r.lapse === 0)) continue;
    const key = `yearend:${r.employeeId}:${r.typeId}:${r.cycleStart}`;
    const post = async (cycle: string, date: string, kind: string, amount: number, suffix: string, note: string) => {
      if (amount === 0) return false;
      const ins = await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, note, idempotency_key, created_by)
        values (${actor.tenant.id}, ${r.employeeId}, ${r.typeId}, ${cycle}, ${date}, ${kind}, ${amount}, 'year_end', ${note}, ${`${key}:${suffix}`}, ${actor.userId})
        on conflict (tenant_id, idempotency_key) do nothing returning id`;
      return ins.length > 0;
    };
    const next = addMonthsISO(r.cycleStart, 12);
    await post(r.cycleStart, r.cycleEnd, "carry_forward", -r.carry, "out", `Carried to the leave year starting ${next}`);
    await post(next, next, "carry_forward", r.carry, "in", `Carried from the leave year ending ${r.cycleEnd}`);
    await post(r.cycleStart, r.cycleEnd, "lapse", -r.lapse, "lapse", "Lapsed at year end");
    const encashed = await post(r.cycleStart, r.cycleEnd, "encash", -r.encash, "encash", `Encashed in payroll ${encashMonth}`);
    if (encashed) {
      await tx`
        insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, days, source_month, source_ref, note, created_by)
        select ${actor.tenant.id}, e.pay_group_id, ${encashMonth + "-01"}, e.id, 'leave_encashment', ${r.encash}, ${r.cycleEnd.slice(0, 7) + "-01"},
               ${tx.json({ ledger_key: `${key}:encash`, leave_type_id: r.typeId })}, ${`${r.type} encashment`}, ${actor.userId}
        from employees e where e.id = ${r.employeeId} and e.pay_group_id is not null`;
    }
    processed++;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'leave_plan', ${plan.id}, 'leave.year_end', ${tx.json({ processed, encashMonth })})`;
  return { processed };
}

// ---------------------------------------------------------------- comp-off expiry

/** Expires comp-off credits whose use-by date has passed, first in first out (see compOffExpiries). Idempotent per credit. */
export async function processCompOffExpiry(tx: Tx, tenantId: string, asOf: ISODate) {
  const due = await tx<{ employee_id: string; leave_type_id: string }[]>`
    select distinct l.employee_id, l.leave_type_id from leave_ledger l join comp_off_requests q on q.id = l.ref_id
    where l.kind = 'comp_off_credit' and q.expires_on < ${asOf}
      and not exists (select 1 from leave_ledger x where x.idempotency_key = 'expiry:' || q.id::text)`;
  let expired = 0, days = 0;
  for (const g of due) {
    const [tot] = await tx<{ outstanding: string; other: string }[]>`
      select coalesce(sum(amount) filter (where kind <> 'carry_forward'), 0) as outstanding,
             coalesce(sum(amount) filter (where kind in ('adjust','opening','accrual') and amount > 0), 0) as other
      from leave_ledger where employee_id = ${g.employee_id} and leave_type_id = ${g.leave_type_id}`;
    const credits = await tx<{ id: string; amount: string; expires_on: string | null }[]>`
      select q.id, l.amount, q.expires_on::text from leave_ledger l join comp_off_requests q on q.id = l.ref_id
      where l.employee_id = ${g.employee_id} and l.leave_type_id = ${g.leave_type_id} and l.kind = 'comp_off_credit'
        and not exists (select 1 from leave_ledger x where x.idempotency_key = 'expiry:' || q.id::text)`;
    const out = compOffExpiries({ outstanding: Number(tot.outstanding), neverExpiring: Number(tot.other), asOf,
      credits: credits.map((c) => ({ id: c.id, amount: Number(c.amount), expiresOn: c.expires_on })) });
    const cycle = await cycleStartFor(tx, g.employee_id, asOf);
    for (const e of out) {
      const c = credits.find((x) => x.id === e.id)!;
      const ins = await tx`
        insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key)
        values (${tenantId}, ${g.employee_id}, ${g.leave_type_id}, ${cycle}, ${asOf}, 'expiry', ${-e.amount}, 'comp_off_request', ${e.id},
                ${e.amount > 0 ? `Comp-off expired (use by ${c.expires_on})` : "Comp-off reached its use-by date; it had already been used"}, ${`expiry:${e.id}`})
        on conflict (tenant_id, idempotency_key) do nothing returning id`;
      if (ins.length && e.amount > 0) { expired++; days = round2(days + e.amount); }
    }
  }
  return { expired, days };
}

/** The nightly leave job for one tenant: accruals, comp-off expiry, then event-based grants past their window. */
export async function runLeaveJobs(tx: Tx, tenantId: string, asOf: ISODate) {
  const accrual = await runAccrual(tx, tenantId, asOf);
  const expiry = await processCompOffExpiry(tx, tenantId, asOf);
  const { lapseExpiredGrants } = await import("./grants");
  const grants = await lapseExpiredGrants(tx, tenantId, asOf);
  return { accrual, expiry, grants };
}
