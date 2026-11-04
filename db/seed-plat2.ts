/**
 * plat2 seed for the demo tenant: two automations (joiner welcome task, birthday wall post), a customised
 * "request approved" email template, an OAuth2 client (secret printed once) and Hindi for one person.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { saveAutomation } from "@/server/modules/automations/service";
import { saveEmailTemplate } from "@/server/modules/notifications/service";
import { createOAuthClient } from "@/server/modules/integrations/oauth";

export async function seedPlat2(tenantId: string) {
  await withTenant(tenantId, async (tx) => {
    const [t] = await tx<{ id: string; name: string; subdomain: string; plan: "pro"; status: string }[]>`select id, name, subdomain::text, plan, status from tenants`;
    const [asha] = await tx<{ id: string; user_id: string; display_name: string; email: string }[]>`select e.id, e.user_id, e.display_name, u.email::text from employees e join users u on u.id = e.user_id where e.first_name = 'Asha'`;
    const actor: Actor = { tenant: { id: t.id, name: t.name, subdomain: t.subdomain, plan: t.plan, status: t.status }, userId: asha.user_id, employeeId: asha.id, name: asha.display_name, email: asha.email, title: null, roles: ["global_admin"], permissions: new Set(["*"]), grants: [{ permissions: ["*"], scopes: [] }] };
    const [existing] = await tx<{ id: string }[]>`select id from automations limit 1`;
    if (existing) return;
    await saveAutomation(tx, actor, null, {
      name: "Welcome new joiners", trigger: "employee.joined", conditions: [],
      actions: [
        { type: "task", to: "manager", title: "Set up {{employee.first_name}}'s first week", due_days: 3 },
        { type: "notify", to: ["employee"], title: "Welcome to {{company}}, {{employee.first_name}}!", body: "Your manager {{manager.name}} will reach out with a plan for your first week." },
      ],
    });
    await saveAutomation(tx, actor, null, {
      name: "Birthday wishes on the wall", trigger: "birthday", conditions: [],
      actions: [{ type: "announcement", title: "Happy birthday, {{employee.first_name}}!", body: "Wish {{employee.name}} ({{employee.department}}) a great year ahead." }],
    });
    await saveAutomation(tx, actor, null, {
      name: "Probation ends in a week: remind the manager", trigger: "date_offset", trigger_config: { field: "probation_end_date", offset_days: -7 },
      conditions: [{ field: "probation_status", op: "in", value: ["in_probation", "extended"] }],
      actions: [{ type: "notify", to: ["manager", "hr_admins"], title: "{{employee.name}}'s probation ends on {{date}} + 7 days", body: "Confirm or extend it from their profile." }],
    });
    await saveEmailTemplate(tx, actor, "request.approved", { subject: "Approved ✅ {{body}}", body: "Hi {{first_name}},\n\nGood news from {{company}}: your request was approved.\n\n{{body}}" });
    const c = await createOAuthClient(tx, actor, { name: "Demo integration (Zapier)", scopes: ["employees:read", "leave:read", "leave:write", "attendance:write", "hooks:write"] });
    console.log(`  demo OAuth2 client (secret shown once): ${c.clientId} / ${c.secret}`);
    await tx`update users set locale = 'hi' where id = (select user_id from employees where first_name = 'Divya')`;   // Divya sees erp in Hindi
  });
}
