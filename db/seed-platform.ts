/**
 * Platform demo data for the seeded tenant: setup marked finished (Acme is an established company), plus a
 * few sign-in attempts so the audit log's Sign-ins tab isn't empty. Called once at the end of db/seed.ts.
 */
import { withTenant } from "@/server/db";
import { STEP_KEYS } from "@/server/modules/setup/rules";

export async function seedPlatform(tenantId: string) {
  await withTenant(tenantId, async (tx) => {
    const at = new Date().toISOString();
    const steps = Object.fromEntries(STEP_KEYS.map((k) => [k, { status: "done", at }]));
    await tx`update tenants set setup_state = ${tx.json({ status: "done", startedAt: at, finishedAt: at, steps })} where id = ${tenantId}`;
    const people = await tx<{ user_id: string; email: string; first_name: string }[]>`
      select e.user_id, u.email::text as email, e.first_name from employees e join users u on u.id = e.user_id where e.first_name in ('Asha', 'Priya', 'Rohan', 'Arjun')`;
    const ip = ["49.204.12.7", "103.21.58.140", "106.51.77.12", "122.171.20.9"];
    for (const [i, p] of people.entries()) {
      for (let d = 6; d >= 0; d -= 2) {
        await tx`insert into login_events (tenant_id, user_id, email, method, success, ip, created_at)
                 values (${tenantId}, ${p.user_id}, ${p.email}, 'password', true, ${ip[i % ip.length]}, now() - make_interval(days => ${d}, hours => ${i + 1}))`;
      }
    }
    const arjun = people.find((p) => p.first_name === "Arjun");
    if (arjun) await tx`insert into login_events (tenant_id, user_id, email, method, success, ip, created_at)
                        values (${tenantId}, ${arjun.user_id}, ${arjun.email}, 'password', false, '106.51.77.12', now() - interval '3 days 2 hours')`;
    await tx`insert into login_events (tenant_id, user_id, email, method, success, ip, created_at)
             values (${tenantId}, null, 'someone@example.com', 'password', false, '185.220.101.4', now() - interval '1 day 5 hours')`;
  });
}
