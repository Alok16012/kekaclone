/**
 * time3 demo data for the seeded tenant (called once at the end of db/seed.ts): an event-based leave type with a grant,
 * a "Field staff" clock-in policy (selfie, first-device approval, accuracy limit) for Divya, a ZKTeco device on the ADMS
 * push protocol, a second holiday list for another location, and an accrual cap on the trainees' casual leave.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { grantLeave } from "@/server/modules/leave/grants";
import { createDevice } from "@/server/modules/attendance/devices";

export async function seedTime3(tenantId: string) {
  const today = todayIn();
  const year = Number(today.slice(0, 4));
  await withTenant(tenantId, async (tx) => {
    const people = await tx<{ id: string; user_id: string; display_name: string; first_name: string }[]>`select id, user_id, display_name, first_name from employees`;
    const id = (first: string) => people.find((p) => p.first_name === first)!.id;
    const actor = (first: string, perms: string[] = []): Actor => {
      const p = people.find((x) => x.first_name === first)!;
      return { tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" }, userId: p.user_id, employeeId: p.id, name: p.display_name, email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes: [] }] : [] };
    };
    const asha = actor("Asha", ["*"]);

    // event-based leave: "Marriage leave" in the default plan, granted per event (no yearly quota); Vikram has a grant for his wedding
    const [plan] = await tx<{ id: string }[]>`select id from leave_plans where is_default limit 1`;
    const [ml] = await tx<{ id: string }[]>`insert into leave_types (tenant_id, name, code, kind, is_paid, color) values (${tenantId}, 'Marriage leave', 'ML', 'incident', true, 'var(--chart-6)') returning id`;
    await tx`insert into leave_plan_rules (tenant_id, leave_plan_id, leave_type_id, yearly_quota, accrual, application, year_end, approval)
             values (${tenantId}, ${plan.id}, ${ml.id}, null, ${tx.json({ frequency: "upfront", day: 1, prorate_joining: false, stop_in_probation: false })},
                     ${tx.json({ allowHalfDay: false, backdateDays: 7, sandwich: { enabled: true } })}, ${tx.json({ carry: "none" })}, ${tx.json({})})`;
    await grantLeave(tx, asha, { employeeId: id("Vikram"), leaveTypeId: ml.id, event: "Wedding", days: 5, validFrom: today, validTo: addDaysISO(today, 60), note: "Congratulations!" });

    // accrual stop rules on the trainees' plan: casual leave stops accruing above 6 days
    await tx`update leave_plan_rules r set accrual = r.accrual || '{"cap_balance": 6}'::jsonb
             from leave_plans p, leave_types t where r.leave_plan_id = p.id and p.name = 'Trainees' and t.id = r.leave_type_id and t.code = 'CL'`;

    // field staff: no office network, location clock-in with a selfie, new devices approved by the manager, 150 m accuracy
    const [fence] = await tx<{ id: string }[]>`insert into geofences (tenant_id, name, lat, lng, radius_m) values (${tenantId}, 'Whitefield client site', 12.9698, 77.7500, 250) returning id`;
    const [field] = await tx<{ id: string }[]>`insert into capture_policies (tenant_id, name, web, mobile) values (${tenantId}, 'Field staff',
      ${tx.json({ enabled: false, comment_required: false, ip_ranges: [] })},
      ${tx.json({ enabled: true, geofence_ids: [fence.id], selfie: true, first_clock_in_approval: true, accuracy_m: 150 })}) returning id`;
    await tx`update employees set capture_policy_id = ${field.id} where id = ${id("Divya")}`;

    // a ZKTeco terminal that pushes its own logs (ADMS): identified by serial, local IST clock running 90 s fast
    await createDevice(tx, asha, { name: "Warehouse terminal", serial: "AEXC2230001", vendor: "zkteco", locationId: null, protocol: "adms", timezone: "Asia/Kolkata", clockOffsetSeconds: 90 });

    // a second holiday list for another location (regional days differ)
    const [pune] = await tx<{ id: string }[]>`insert into holiday_lists (tenant_id, name, year, floater_limit) values (${tenantId}, 'Pune plant', ${year}, 1) on conflict do nothing returning id`;
    if (pune) {
      for (const [name, md, floater] of [["Republic Day", "01-26", false], ["Maharashtra Day", "05-01", false], ["Independence Day", "08-15", false], ["Ganesh Chaturthi (optional)", "09-14", true], ["Diwali", "11-08", false], ["Christmas", "12-25", false]] as const) {
        await tx`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater) values (${tenantId}, ${pune.id}, ${name}, ${`${year}-${md}`}, ${floater}) on conflict do nothing`;
      }
      const [loc] = await tx<{ id: string }[]>`select id from locations where default_holiday_list_id is null order by created_at desc limit 1`;
      if (loc) await tx`update locations set default_holiday_list_id = ${pune.id} where id = ${loc.id}`;
    }
  });
}
