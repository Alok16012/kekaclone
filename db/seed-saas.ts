/**
 * SaaS seed for the demo tenant: a 30-day Pro trial (every feature on), billing details, a demo API key
 * (token printed once below), a disabled webhook endpoint and a sign-in note. Mobile numbers for OTP sign-in.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { createApiKey, createEndpoint, setEndpointActive } from "@/server/modules/integrations/service";

export async function seedSaas(tenantId: string) {
  await withTenant(tenantId, async (tx) => {
    await tx`update tenants set plan = 'pro', status = 'trial', trial_ends_at = now() + interval '21 days',
      billing = billing || ${tx.json({ gstin: "29ABCDE1234F1Z5", billing_email: "accounts@acme.example" })},
      branding = branding || ${tx.json({ login_note: "Use your Acme work email, or the mobile number on your profile." })},
      auth_settings = auth_settings || ${tx.json({ mobile_otp: true })}`;
    // mobile numbers so OTP sign-in has something to send to (dev SMS log at /dev/sms)
    const people = await tx<{ user_id: string; i: number }[]>`select user_id, row_number() over (order by employee_number)::int as i from employees where user_id is not null`;
    for (const p of people) await tx`update users set phone = ${`+919800${String(100000 + p.i).slice(-6)}`} where id = ${p.user_id} and phone is null`;
    const [t] = await tx<{ id: string; name: string; subdomain: string; plan: "pro"; status: string }[]>`select id, name, subdomain::text, plan, status from tenants`;
    const [asha] = await tx<{ id: string; user_id: string; display_name: string; email: string }[]>`select e.id, e.user_id, e.display_name, u.email::text from employees e join users u on u.id = e.user_id where e.first_name = 'Asha'`;
    const actor: Actor = { tenant: { id: t.id, name: t.name, subdomain: t.subdomain, plan: t.plan, status: t.status }, userId: asha.user_id, employeeId: asha.id, name: asha.display_name, email: asha.email, title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] };
    const [existing] = await tx<{ id: string }[]>`select id from api_keys limit 1`;
    if (!existing) {
      const k = await createApiKey(tx, actor, { name: "Demo BI dashboard", scopes: ["employees:read", "departments:read", "locations:read", "leave:read", "attendance:read"] });
      console.log(`  demo API key (shown once): ${k.token}`);
      const w = await createEndpoint(tx, actor, { url: "https://example.com/erp-webhook", events: ["approval.decided", "employee.created"] });
      await setEndpointActive(tx, actor, w.id, false);   // off, so the seed never calls out
    }
  });
}
