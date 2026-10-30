/**
 * Demo content for the Home wall (Engage) on the acme tenant: called at the end of db/seed.ts.
 * Gives HR admins announcement access, fills in a few birthdays, and posts an announcement (pinned), a scheduled one,
 * a poll with votes, a praise, a couple of posts with comments and reactions.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { addDaysISO, todayIn } from "@/lib/dates";
import { DEFAULT_BADGES } from "@/server/modules/engage/rules";
import * as engage from "@/server/modules/engage/service";

export async function seedEngage(tenantId: string) {
  const today = todayIn();
  await withTenant(tenantId, async (tx) => {
    for (const b of DEFAULT_BADGES) await tx`insert into badges (tenant_id, name, icon) values (${tenantId}, ${b.name}, ${b.icon}) on conflict (tenant_id, name) do nothing`;
    // existing roles: HR admins announce and moderate
    await tx`update roles set permissions = array_append(permissions, 'engage.announce') where key = 'hr_admin' and not ('engage.announce' = any(permissions))`;

    // a few birthdays this week (Divya keeps her profile private: Home shows only her name)
    const md = (days: number) => addDaysISO(today, days).slice(5);
    await tx`update employees set dob = ${`1994-${md(0)}`}::date where first_name = 'Meera'`;
    await tx`update employees set dob = ${`1991-${md(3)}`}::date where first_name = 'Vikram'`;
    await tx`update employees set dob = ${`1996-${md(2)}`}::date, is_private = true where first_name = 'Divya'`;
    await tx`update employees set dob = ${`1989-${md(40)}`}::date where first_name = 'Rohan'`;

    const actor = async (first: string): Promise<Actor> => {
      const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
      const roles = await tx<{ permissions: string[]; scopes: Scope[] }[]>`select r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${e.id}`;
      return {
        tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" }, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null,
        roles: [], permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })),
      };
    };
    const [asha, priya, rohan, arjun, meera, karan, sneha] = await Promise.all(["Asha", "Priya", "Rohan", "Arjun", "Meera", "Karan", "Sneha"].map(actor));
    const [eng] = await tx<{ id: string }[]>`select id from departments where name = 'Engineering'`;
    const [badge] = await tx<{ id: string }[]>`select id from badges where name = 'Above and beyond'`;
    const ago = async (id: string | undefined, hours: number) => { if (id) await tx`update posts set publish_at = now() - make_interval(hours => ${hours}), created_at = now() - make_interval(hours => ${hours}) where id = ${id}`; };

    const welcome = await engage.createPost(tx, asha, {
      kind: "announcement", title: "Say hello to the new Home wall",
      body: "This is where company news, polls and shout-outs will live from now on. Post an update, praise a teammate, or vote in this week's poll.",
      audience: { type: "org" }, pinnedUntil: addDaysISO(today, 14),
    });
    await ago(welcome.item?.id, 50);

    const party = await engage.createPost(tx, priya, {
      kind: "poll", body: "Where should we hold the year-end party?",
      poll: { options: ["Rooftop dinner", "Beach day", "Bowling and games night"], multiple: false, anonymous: false, endsAt: new Date(Date.now() + 6 * 864e5).toISOString() },
    });
    await ago(party.item?.id, 30);
    const opts = party.item!.poll!.options;
    for (const [who, i] of [[arjun, 0], [meera, 2], [karan, 0], [sneha, 1], [rohan, 0]] as const) await engage.vote(tx, who, party.item!.id, [opts[i].id]);

    const praise = await engage.createPost(tx, rohan, {
      kind: "praise", body: "Stayed late to get the payroll export working before the deadline, and wrote great docs for it too. Thank you both!",
      praise: { recipientIds: [arjun.employeeId, meera.employeeId], badgeId: badge.id },
    });
    await ago(praise.item?.id, 20);
    await engage.react(tx, asha, praise.item!.id, "celebrate");
    await engage.react(tx, priya, praise.item!.id, "love");
    await engage.addComment(tx, priya, praise.item!.id, "Well deserved!");

    const eng1 = await engage.createPost(tx, meera, {
      kind: "post", body: "Reminder: code freeze for the November release starts Thursday evening. Please get your reviews in by then.",
      audience: { type: "departments", ids: [eng.id] },
    });
    await ago(eng1.item?.id, 8);
    await engage.react(tx, arjun, eng1.item!.id, "like");
    await engage.addComment(tx, arjun, eng1.item!.id, "Noted, mine are in review now.");

    const eng2 = await engage.createPost(tx, priya, {
      kind: "announcement", title: "Laptop refresh for Engineering",
      body: "New laptops arrive next week. IT will email each of you a slot to swap your device.", audience: { type: "departments", ids: [eng.id] },
    });
    await ago(eng2.item?.id, 5);

    const hello = await engage.createPost(tx, karan, { kind: "post", body: "Reimbursement claims for October close on the 5th. Upload your bills before then so they make this payroll." });
    await ago(hello.item?.id, 3);
    for (const who of [asha, sneha, rohan]) await engage.react(tx, who, hello.item!.id, "like");
    await engage.addComment(tx, sneha, hello.item!.id, "Thanks for the heads-up!");

    // scheduled for tomorrow morning: shows in Announcements, not yet on the wall
    await engage.createPost(tx, priya, {
      kind: "announcement", title: "Open enrolment for health insurance",
      body: "Add or update your dependants for next year's health cover. The window is open for two weeks.",
      audience: { type: "org" }, publishAt: new Date(`${addDaysISO(today, 1)}T10:00:00+05:30`).toISOString(),
    });
  });
}
