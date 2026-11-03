/**
 * Time extras for the demo tenant: pay codes, an overtime policy (approval-based, paid on working days, comp-off on
 * off days) for the engineers, a night-shift allowance, shift-change rules, two biometric devices, a rostered week
 * for Imran, an approved overtime claim for Meera, and a couple of notification settings. Called once at the end of db/seed.ts.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import { createRequest } from "@/server/modules/attendance/requests";
import { processAttendance } from "@/server/modules/attendance/process";
import { decide, inbox } from "@/server/modules/approvals/service";
import { DEFAULT_OVERTIME_RULES } from "@/server/modules/attendance/overtime-rules";
import { createDevice } from "@/server/modules/attendance/devices";
import { weekStartOf } from "@/server/modules/attendance/roster-rules";

const working = (d: string) => !["sat", "sun"].includes(weekday(d));

export async function seedTime2(tenantId: string) {
  const today = todayIn();
  await withTenant(tenantId, async (tx) => {
    const people = await tx<{ id: string; user_id: string; display_name: string; first_name: string }[]>`select id, user_id, display_name, first_name from employees`;
    const id = (first: string) => people.find((p) => p.first_name === first)!.id;
    const actor = (first: string, perms: string[] = []): Actor => {
      const p = people.find((x) => x.first_name === first)!;
      return { tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" }, userId: p.user_id, employeeId: p.id, name: p.display_name, email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes: [] }] : [] };
    };
    const asha = actor("Asha", ["*"]);

    // HR admins may change notification settings
    await tx`update roles set permissions = array_append(permissions, 'settings.notifications') where key = 'hr_admin' and not ('settings.notifications' = any(permissions))`;

    // pay codes + overtime policy for the engineers
    const [double] = await tx<{ id: string }[]>`insert into pay_codes (tenant_id, name, kind, value) values (${tenantId}, 'Double time', 'multiplier', 2) returning id`;
    await tx`insert into pay_codes (tenant_id, name, kind, value) values (${tenantId}, 'Flat ₹150 an hour', 'fixed_per_hour', 150)`;
    const rules = { ...DEFAULT_OVERTIME_RULES, working: { ...DEFAULT_OVERTIME_RULES.working, pay_code_id: double.id } };
    const [policy] = await tx<{ id: string }[]>`insert into overtime_policies (tenant_id, name, rules) values (${tenantId}, 'Standard overtime', ${tx.json(rules)}) returning id`;
    await tx`update employees set overtime_policy_id = ${policy.id} where id in (${id("Arjun")}, ${id("Meera")}, ${id("Vikram")}, ${id("Imran")})`;

    // night-shift allowance, shift-change rule
    const [night] = await tx<{ id: string }[]>`select id from shifts where code = 'NIGHT'`;
    const [gen] = await tx<{ id: string }[]>`select id from shifts where code = 'GEN'`;
    await tx`insert into shift_allowance_policies (tenant_id, name, shift_ids, amount_paise, per, component_code) values (${tenantId}, 'Night shift allowance', ${[night.id]}::uuid[], 20000, 'day', 'SHIFT_ALLOWANCE')`;
    await tx`insert into shift_rules (tenant_id, name, allowed_shift_ids, request_window_days, max_requests_per_month, allow_on_off_days) values (${tenantId}, 'Standard', '{}', 30, 2, false)`;

    // biometric devices (keys are shown once when created; these demo ones are simply not kept)
    const [loc] = await tx<{ id: string }[]>`select id from locations order by created_at limit 1`;
    await createDevice(tx, asha, { name: "Reception gate", serial: "RG-001", vendor: "zkteco", locationId: loc?.id ?? null });
    await createDevice(tx, asha, { name: "Factory turnstile", serial: "FT-02", vendor: "essl", locationId: null });

    // Imran's roster next week: three nights, then a day off, then back to General
    const nextMonday = addDaysISO(weekStartOf(today), 7);
    for (const [i, shift] of [night.id, night.id, night.id, null, gen.id].entries()) {
      await tx`insert into roster_entries (tenant_id, employee_id, date, shift_id) values (${tenantId}, ${id("Imran")}, ${addDaysISO(nextMonday, i)}, ${shift}) on conflict (employee_id, date) do nothing`;
    }

    // Meera stayed late a week ago and claimed overtime; Rohan approved it
    const past = Array.from({ length: 14 }, (_, i) => addDaysISO(today, -(i + 1))).filter(working);
    const lateDay = past[3] ?? past[past.length - 1];   // within the 7-day claim window
    if (lateDay) {
      await tx`update punches set at = ${new Date(`${lateDay}T21:05:00+05:30`)} where employee_id = ${id("Meera")} and direction = 'out' and (at at time zone 'Asia/Kolkata')::date = ${lateDay}::date`;
      await processAttendance(tx, tenantId, id("Meera"), lateDay);
      const r = await createRequest(tx, actor("Meera"), { kind: "overtime", date: lateDay, minutes: 120, reason: "Release night for the payroll module" });
      const step = (await inbox(tx, actor("Rohan"))).find((i) => i.entity_id === r.id);
      if (step) await decide(tx, actor("Rohan"), step.step_id, "approved", "Thanks for staying back");
    }

    // notification settings: praise stays in-app only; the approvers' digest goes by email
    await tx`insert into notification_settings (tenant_id, event, channels) values (${tenantId}, 'engage.praise', '{in_app}'), (${tenantId}, 'approvals.digest', '{email}') on conflict (tenant_id, event) do nothing`;
  });
}

