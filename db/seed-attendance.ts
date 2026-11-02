/**
 * Attendance demo data for the seeded tenant (called at the end of db/seed.ts):
 * extra shifts (night, flexible), an alternate-Saturdays weekly off, a Bengaluru geofence, an office-only capture policy
 * for Sales, a standard penalty policy for everyone, a few late arrivals and a missing swipe, and pending requests
 * for Rohan to review. Then the last two weeks are processed so penalties show up.
 */
import { withTenant, type Tx } from "@/server/db";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import { processAttendance } from "@/server/modules/attendance/process";
import { createRequest } from "@/server/modules/attendance/requests";
import type { Actor } from "@/server/auth/session";

const weekdays5 = ["mon", "tue", "wed", "thu", "fri"];
const working = (d: string) => !["sat", "sun"].includes(weekday(d));

/**
 * Arjun's four seeded late arrivals (ascending): the most recent four past working days that fall in ONE calendar month,
 * so the monthly "3 free, then ½ CL" penalty always fires on the 4th, even in the first days of a month.
 */
export function arjunLateDays(today: string): string[] {
  const past = Array.from({ length: 14 }, (_, i) => addDaysISO(today, -(i + 1))).filter(working);
  for (const month of [...new Set(past.map((d) => d.slice(0, 7)))]) {
    const inMonth = past.filter((d) => d.slice(0, 7) === month);
    if (inMonth.length >= 4) return inMonth.slice(0, 4).sort();
  }
  return past.slice(0, 4).sort();
}

export async function seedAttendance(tenantId: string) {
  const today = todayIn();
  await withTenant(tenantId, async (tx) => {
    const people = await tx<{ id: string; first_name: string; joining_date: string; user_id: string; display_name: string }[]>`
      select id, first_name, joining_date::text, user_id, display_name from employees`;
    const id = (first: string) => people.find((p) => p.first_name === first)!.id;
    const actor = (first: string): Actor => {
      const p = people.find((x) => x.first_name === first)!;
      return { tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" }, userId: p.user_id, employeeId: p.id, name: p.display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [] };
    };

    // shifts
    const [general] = await tx<{ id: string }[]>`select id from shifts where code = 'GEN'`;
    const [night] = await tx<{ id: string }[]>`insert into shifts (tenant_id, name, code, kind, timings, break_minutes, grace_minutes, half_day_minutes)
      values (${tenantId}, 'Night', 'NIGHT', 'fixed', ${tx.json(Object.fromEntries(weekdays5.map((d) => [d, { start: "22:00", end: "06:00" }])))}, 30, 10, 240) returning id`;
    await tx`insert into shifts (tenant_id, name, code, kind, timings, break_minutes, grace_minutes, half_day_minutes)
      values (${tenantId}, 'Flexible', 'FLEX', 'flexible', ${tx.json(Object.fromEntries(weekdays5.map((d) => [d, { start: "10:00", end: "19:00" }])))}, 60, 0, 240)`;

    // weekly offs
    await tx`insert into weekly_off_policies (tenant_id, name, pattern) values (${tenantId}, 'Alternate Saturdays', ${tx.json({ sat: ["off", "work", "off", "work", "work"], sun: "off" })})`;

    // capture: default stays open; Sales must be on the office network or inside the Bengaluru geofence
    const [fence] = await tx<{ id: string }[]>`insert into geofences (tenant_id, name, lat, lng, radius_m) values (${tenantId}, 'Bengaluru office', 12.9716, 77.5946, 200) returning id`;
    await tx`update capture_policies set limits = ${tx.json({ regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 })} where name = 'Default'`;
    const [office] = await tx<{ id: string }[]>`insert into capture_policies (tenant_id, name, web, mobile) values (${tenantId}, 'Office network or location',
      ${tx.json({ enabled: true, comment_required: false, ip_ranges: ["203.0.113.0/24"] })},
      ${tx.json({ enabled: true, geofence_ids: [fence.id], selfie: false, first_clock_in_approval: false })}) returning id`;
    await tx`update employees set capture_policy_id = ${office.id} where id in (${id("Sneha")}, ${id("Imran")})`;

    // penalties: 3 free late arrivals a month, then half a day of casual leave each; no attendance = loss of pay
    const [cl] = await tx<{ id: string }[]>`select id from leave_types where code = 'CL'`;
    const [standard] = await tx<{ id: string }[]>`insert into penalization_policies (tenant_id, name, late_arrival, hours_shortage, no_attendance, missing_swipe, deduct_from_leave_type_ids)
      values (${tenantId}, 'Standard',
        ${tx.json({ enabled: true, grace_minutes: null, free_per_month: 3, deduct_days: 0.5 })},
        ${tx.json({ enabled: true, basis: "effective", full_day_minutes: 420, half_day_minutes: 240 })},
        ${tx.json({ enabled: true })}, ${tx.json({ enabled: true, deduct_days: 0.5 })}, ${[cl.id]}::uuid[]) returning id`;
    await tx`update employees set penalization_policy_id = ${standard.id}`;

    // everyone is on General + Sat/Sun from joining (set when they were added); Vikram moves to nights from tomorrow
    const tomorrow = addDaysISO(today, 1);
    await tx`update shift_assignments set period = daterange(lower(period), ${tomorrow}::date) where employee_id = ${id("Vikram")} and shift_id = ${general.id}`;
    await tx`insert into shift_assignments (tenant_id, employee_id, shift_id, period) values (${tenantId}, ${id("Vikram")}, ${night.id}, daterange(${tomorrow}::date, null))`;

    // Arjun came in late on the last four working days; Karan forgot to clock out once
    const past = Array.from({ length: 14 }, (_, i) => addDaysISO(today, -(i + 1))).filter(working);
    for (const d of arjunLateDays(today)) await moveIn(tx, id("Arjun"), d, "10:05");
    await tx`delete from punches where employee_id = ${id("Karan")} and direction = 'out' and (at at time zone 'Asia/Kolkata')::date = ${past[2]}::date`;

    // re-run the last two weeks with the policies in place
    for (const p of people) for (let back = 14; back >= 0; back--) {
      const d = addDaysISO(today, -back);
      if (d >= p.joining_date) await processAttendance(tx, tenantId, p.id, d);
    }

    // requests waiting for Rohan: Meera regularizes a day, Arjun works from home next working day
    let next = addDaysISO(today, 1); while (!working(next)) next = addDaysISO(next, 1);
    await createRequest(tx, actor("Meera"), { kind: "regularization", date: past[1], inTime: "09:25", outTime: "18:45", reason: "The office card reader was down in the morning" });
    await createRequest(tx, actor("Arjun"), { kind: "wfh", from: next, to: next, half: null, reason: "Waiting for an internet installation at home" });
  });
}

async function moveIn(tx: Tx, employeeId: string, date: string, hhmm: string) {
  await tx`update punches set at = ${new Date(`${date}T${hhmm}:00+05:30`)}
    where employee_id = ${employeeId} and direction = 'in' and (at at time zone 'Asia/Kolkata')::date = ${date}::date`;
}
