/**
 * Core HR demo data for the seeded tenant (called at the end of db/seed.ts): custom fields (published + a draft),
 * groups, people on probation (one due soon, one past its end under an auto-confirm policy), family / education /
 * experience / IDs for Arjun and Meera, a conditional approval workflow and a future approval hand-over.
 */
import { withTenant } from "@/server/db";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import * as fields from "@/server/modules/corehr/custom-fields";
import * as sections from "@/server/modules/corehr/profile-sections";
import * as life from "@/server/modules/corehr/lifecycle";
import * as appr from "@/server/modules/corehr/approvals-admin";

export async function seedCoreHr(tenantId: string) {
  const today = todayIn();
  await withTenant(tenantId, async (tx) => {
    const people = await tx<{ id: string; first_name: string; user_id: string; display_name: string }[]>`select id, first_name, user_id, display_name from employees`;
    const p = (first: string) => people.find((x) => x.first_name === first)!;
    const actor = (first: string, perms: string[] = []): Actor => ({
      tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" }, userId: p(first).user_id, employeeId: p(first).id, name: p(first).display_name,
      email: "", title: null, roles: [], permissions: new Set(perms), grants: perms.length ? [{ permissions: perms, scopes: [] }] : [],
    });
    const asha = actor("Asha", ["*"]), priya = actor("Priya", ["employees.read", "employees.write", "settings.org"]);

    // custom fields: nothing required, so the Excel import round-trip stays valid
    const shirt = await fields.saveDef(tx, asha, null, { label: "T-shirt size", section: "Other details", type: "select", options: ["S", "M", "L", "XL"], required: false, viewRoles: ["employee", "manager"], editRoles: ["employee"] });
    const cost = await fields.saveDef(tx, asha, null, { label: "Cost centre", section: "Other details", type: "text", required: false, viewRoles: ["employee", "manager"], editRoles: [] });
    const emergency = await fields.saveDef(tx, asha, null, { label: "Emergency contact number", section: "Emergency", type: "phone", required: false, viewRoles: ["employee"], editRoles: ["employee"] });
    await fields.saveDef(tx, asha, null, { label: "Laptop preference", section: "Other details", type: "select", options: ["Mac", "Windows", "Linux"], required: false, viewRoles: ["employee"], editRoles: ["employee"] });
    for (const d of [shirt, cost, emergency]) await fields.setDefStatus(tx, asha, d.id, "published");
    await fields.savePersonFields(tx, asha, p("Arjun").id, { [shirt.key!]: "M", [cost.key!]: "ENG-101" });
    await fields.savePersonFields(tx, actor("Meera"), p("Meera").id, { [shirt.key!]: "S", [emergency.key!]: "+91 98450 12345" });

    // groups
    const project = await life.saveGroupType(tx, asha, null, "Project");
    const committee = await life.saveGroupType(tx, asha, null, "Committee");
    const apollo = await life.saveGroup(tx, asha, null, { typeId: project.id, name: "Apollo" });
    const posh = await life.saveGroup(tx, asha, null, { typeId: committee.id, name: "POSH committee" });
    await life.setGroupMembers(tx, asha, apollo.id, [p("Arjun").id, p("Meera").id, p("Rohan").id]);
    await life.setGroupMembers(tx, asha, posh.id, [p("Priya").id, p("Asha").id, p("Sneha").id]);

    // probation: Fatima ends in 10 days (manager decides), Aditya's ended two days ago under the auto-confirm policy
    const [standard] = await tx<{ id: string }[]>`select id from probation_policies where not auto_confirm order by created_at limit 1`;
    const [short] = await tx<{ id: string }[]>`select id from probation_policies where auto_confirm order by created_at limit 1`;
    await tx`update employees set probation_policy_id = ${standard.id}, probation_status = 'in_probation', probation_end_date = ${addDaysISO(today, 10)} where id = ${p("Fatima").id}`;
    await tx`update employees set probation_policy_id = ${short.id}, probation_status = 'in_probation', probation_end_date = ${addDaysISO(today, -2)} where id = ${p("Aditya").id}`;

    // profile sections
    const arjun = actor("Arjun");
    await sections.saveSectionRow(tx, arjun, p("Arjun").id, "relation", null, { relation: "mother", name: "Lakshmi Rao", dob: "1968-04-12", mobile: "+91 98860 11223", isNominee: true });
    await sections.saveSectionRow(tx, arjun, p("Arjun").id, "relation", null, { relation: "father", name: "Venkat Rao", profession: "Teacher" });
    await sections.saveSectionRow(tx, arjun, p("Arjun").id, "education", null, { degree: "B.E.", branch: "Computer Science", institution: "RV College of Engineering", score: "8.4 CGPA", startYear: 2015, endYear: 2019 });
    await sections.saveSectionRow(tx, arjun, p("Arjun").id, "experience", null, { company: "Brightlabs Software", title: "Software Engineer", location: "Bengaluru", startDate: "2019-07-01", endDate: "2023-05-31" });
    await sections.saveIdentity(tx, arjun, p("Arjun").id, { kind: "pan", number: "ABCPR1234K", nameOnDoc: "Arjun Rao" });
    const meeraAadhaar = await sections.saveIdentity(tx, actor("Meera"), p("Meera").id, { kind: "aadhaar", number: "234123412346", nameOnDoc: "Meera Iyer" });
    await sections.verifyIdentity(tx, priya, meeraAadhaar.id, true);

    // approvals: interns' profile changes go to their manager, then HR; escalate after 3 days, auto-approve after 7
    await appr.saveWorkflow(tx, asha, null, {
      entityType: "profile_change", name: "Interns: manager, then HR", priority: 10, isActive: true,
      conditions: [{ field: "worker_type", values: ["intern"] }], levels: [{ approver: "manager" }, { approver: "role", role: "hr_admin" }],
      autoApproveAfterDays: 7, escalation: { afterDays: 3, to: { approver: "role", role: "global_admin" } },
    });
    // Rohan is away next month: Meera covers his approvals
    await appr.saveDelegation(tx, actor("Rohan"), { delegatorId: p("Rohan").id, delegateId: p("Meera").id, from: addDaysISO(today, 30), to: addDaysISO(today, 34), reason: "Family wedding" });
  });
}
