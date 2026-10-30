/**
 * End-to-end checks for Engage (Home wall) against the seeded demo tenant (run `pnpm db:seed` first).
 * Every check runs in a rolled-back transaction, so the demo data stays as seeded.
 *   pnpm smoke:engage
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as engage from "@/server/modules/engage/service";
import { getObject, deleteObject } from "@/server/modules/engage/storage";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const ROLLBACK = "rollback";
async function rolledBack(tenantId: string, fn: (tx: Tx) => Promise<void>) {
  await withTenant(tenantId, async (tx) => { await fn(tx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  /** Actor with the roles they really have in the database (like getActor). */
  const actor = (first: string) => withTenant(tenant.id, async (tx): Promise<Actor> => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    const roles = await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${e.id}`;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: roles.map((r) => r.key),
      permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })) };
  });
  const [asha, priya, rohan, arjun, meera, karan] = await Promise.all(["Asha", "Priya", "Rohan", "Arjun", "Meera", "Karan"].map(actor));
  const ids = await withTenant(tenant.id, async (tx) => {
    const d = await tx<{ id: string; name: string }[]>`select id, name from departments`;
    const [b] = await tx<{ id: string }[]>`select id from badges where is_active order by name limit 1`;
    return { eng: d.find((x) => x.name === "Engineering")!.id, fin: d.find((x) => x.name === "Finance")!.id, badge: b.id };
  });
  const notes = (tx: Tx, a: Actor, kind: string) => tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${a.userId} and kind = ${kind}`.then((r) => r[0].n);
  const allItems = async (tx: Tx, a: Actor, tab: engage.FeedTab) => {
    const out: engage.FeedItem[] = []; let cursor: string | null = null;
    do { const p: engage.FeedPage = await engage.feed(tx, a, { tab, cursor, limit: 3 }); out.push(...p.pinned, ...p.items); cursor = p.nextCursor; } while (cursor);
    return out;
  };

  // seed sanity
  assert.ok(priya.permissions.has("engage.announce"), "HR admin role has engage.announce");
  assert.ok(!arjun.permissions.has("engage.announce"));
  await withTenant(tenant.id, async (tx) => {
    const p = await engage.feed(tx, arjun, { tab: "org" });
    assert.ok(p.pinned.some((x) => x.kind === "announcement"), "pinned welcome announcement first");
    assert.ok(p.items.some((x) => x.kind === "poll") && p.items.some((x) => x.kind === "praise"));
  });
  ok("seed: HR admins can announce, employees can't; wall has a pinned announcement, a poll and a praise");

  // permissions: who can announce, and to whom
  await rolledBack(tenant.id, async (tx) => {
    await assert.rejects(engage.createPost(tx, arjun, { kind: "announcement", title: "Hi", body: "x" }), /announcement access/);
    await assert.rejects(engage.createPost(tx, arjun, { kind: "post", body: "Finance only", audience: { type: "departments", ids: [ids.fin] } }), /your own department/);
    await assert.rejects(engage.createPost(tx, arjun, { kind: "post", body: "x", audience: { type: "locations", ids: [randomUUID()] } }), /Only announcements/);
    const r = await engage.createPost(tx, priya, { kind: "announcement", title: "Sprint demo Friday", body: "Join us at 4 pm", audience: { type: "departments", ids: [ids.eng] } });
    assert.ok(r.item && r.item.audience.label === "Engineering");
  });
  ok("permissions: employees can't announce or post to other departments; HR can announce to a department");

  // announcement → audience notified in one batch; outsiders neither see it nor get notified
  await rolledBack(tenant.id, async (tx) => {
    const [a0, k0, p0] = await Promise.all([notes(tx, arjun, "engage.announcement"), notes(tx, karan, "engage.announcement"), notes(tx, priya, "engage.announcement")]);
    const r = await engage.createPost(tx, priya, { kind: "announcement", title: "Engineering offsite", body: "Pack your bags", audience: { type: "departments", ids: [ids.eng] } });
    assert.equal(await notes(tx, arjun, "engage.announcement"), a0 + 1);
    assert.equal(await notes(tx, karan, "engage.announcement"), k0, "Finance isn't notified");
    assert.equal(await notes(tx, priya, "engage.announcement"), p0, "the author isn't notified");
    assert.ok((await allItems(tx, arjun, "org")).some((x) => x.id === r.item!.id), "Engineering sees it on the Organisation tab");
    assert.ok(!(await allItems(tx, karan, "org")).some((x) => x.id === r.item!.id), "Finance doesn't see it");
    assert.equal(await engage.getPost(tx, karan, r.item!.id), null);
    await assert.rejects(engage.react(tx, karan, r.item!.id, "like"), /removed/);
  });
  ok("announcement to Engineering: members notified (not the author), Finance can't see, react or get notified");

  // scheduled announcement: hidden and silent until due, then notifies exactly once
  await rolledBack(tenant.id, async (tx) => {
    const at = new Date(Date.now() + 3600e3).toISOString();
    const a0 = await notes(tx, arjun, "engage.announcement");
    const r = await engage.createPost(tx, priya, { kind: "announcement", title: "Later", body: "Soon", publishAt: at });
    assert.equal(r.item, null); assert.equal(r.scheduledFor, at);
    assert.equal(await notes(tx, arjun, "engage.announcement"), a0);
    const list = await engage.announcementsAdmin(tx, priya);
    const row = list.find((x) => x.title === "Later")!;
    assert.equal(row.status, "scheduled");
    await assert.rejects(engage.announcementsAdmin(tx, arjun), /access/);
    await assert.rejects(engage.reschedule(tx, arjun, row.id, null), /access/);
    const [id] = [row.id];
    await tx`update posts set publish_at = now() - interval '1 minute' where id = ${id}`;   // time passes
    const first = await engage.publishDue(tx, tenant.id);
    assert.equal(first.posts, 1);
    assert.equal((await engage.publishDue(tx, tenant.id)).posts, 0, "second run sends nothing");
    assert.equal(await notes(tx, arjun, "engage.announcement"), a0 + 1);
    await assert.rejects(engage.reschedule(tx, priya, id, at), /already live/);
    // publish-now path for another scheduled one
    const r2 = await engage.createPost(tx, priya, { kind: "announcement", title: "Later 2", body: "Soon", publishAt: at });
    assert.equal(r2.item, null);
    const id2 = (await engage.announcementsAdmin(tx, priya)).find((x) => x.title === "Later 2")!.id;
    assert.equal((await engage.reschedule(tx, priya, id2, null)).posts, 1);
    assert.equal(await notes(tx, arjun, "engage.announcement"), a0 + 2);
  });
  ok("scheduled announcement: not on the wall, no notification; when due notifies once (idempotent); publish-now works; live ones can't be rescheduled");

  // pin / unpin
  await rolledBack(tenant.id, async (tx) => {
    const r = await engage.createPost(tx, priya, { kind: "announcement", title: "Pin me", body: "x" });
    await assert.rejects(engage.setPin(tx, arjun, r.item!.id, todayIn()), /access/);
    await assert.rejects(engage.setPin(tx, priya, r.item!.id, addDaysISO(todayIn(), -1)), /later date/);
    await engage.setPin(tx, priya, r.item!.id, addDaysISO(todayIn(), 3));
    let p = await engage.feed(tx, karan, { tab: "org" });
    assert.ok(p.pinned.some((x) => x.id === r.item!.id) && !p.items.some((x) => x.id === r.item!.id), "pinned shows once, at the top");
    await engage.setPin(tx, priya, r.item!.id, null);
    p = await engage.feed(tx, karan, { tab: "org" });
    assert.ok(!p.pinned.some((x) => x.id === r.item!.id) && p.items.some((x) => x.id === r.item!.id));
    const post = await engage.createPost(tx, arjun, { kind: "post", body: "not an announcement" });
    await assert.rejects(engage.setPin(tx, priya, post.item!.id, todayIn()), /Only announcements/);
  });
  ok("pin/unpin: HR only, not in the past, pinned items sit on top without repeating; posts can't be pinned");

  // department wall
  await rolledBack(tenant.id, async (tx) => {
    const r = await engage.createPost(tx, arjun, { kind: "post", body: "Engineering only", audience: { type: "departments", ids: [ids.eng] } });
    assert.ok((await allItems(tx, meera, "department")).some((x) => x.id === r.item!.id), "Meera (Engineering) sees it on the department tab");
    assert.ok(!(await allItems(tx, meera, "org")).some((x) => x.id === r.item!.id), "department posts stay off the Organisation tab");
    assert.ok(!(await allItems(tx, karan, "department")).some((x) => x.id === r.item!.id));
    assert.equal(await engage.getPost(tx, karan, r.item!.id), null);
    const [{ id: noDept }] = await tx<{ id: string }[]>`update employees set department_id = null where id = ${karan.employeeId} returning id`;
    assert.ok(noDept);
    assert.equal((await engage.feed(tx, karan, { tab: "department" })).noDepartment, true);
  });
  ok("department tab: colleagues in the department see it, others don't; no department → friendly empty state");

  // cursor pagination
  await rolledBack(tenant.id, async (tx) => {
    for (let i = 0; i < 8; i++) await engage.createPost(tx, arjun, { kind: "post", body: `page test ${i}` });   // same publish time: ties broken by id
    const seen = await allItems(tx, meera, "org");
    assert.equal(new Set(seen.map((x) => x.id)).size, seen.length, "no duplicates across pages");
    assert.equal(seen.filter((x) => x.body?.startsWith("page test")).length, 8, "nothing skipped");
    const keys = seen.filter((x) => !x.pinned).map((x) => x.publishedAt);
    assert.deepEqual(keys, [...keys].sort().reverse(), "newest first");
    await assert.rejects(engage.feed(tx, meera, { tab: "org", cursor: "garbage" }), /expired/);
  });
  ok("feed paging: cursor walks every post once, newest first, ties by id; bad cursor refused");

  // polls
  await rolledBack(tenant.id, async (tx) => {
    const r = await engage.createPost(tx, karan, { kind: "poll", body: "Lunch?", poll: { options: ["Pizza", "Dosa", "Salad"], multiple: false, anonymous: true, endsAt: null } });
    const [o1, o2, o3] = r.item!.poll!.options;
    let p = await engage.vote(tx, arjun, r.item!.id, [o1.id]);
    p = await engage.vote(tx, arjun, r.item!.id, [o2.id]);   // change of mind replaces the vote
    assert.deepEqual(p.poll!.options.map((o) => o.votes), [0, 1, 0]); assert.equal(p.poll!.voted, true);
    await engage.vote(tx, meera, r.item!.id, [o2.id]);
    p = await engage.vote(tx, rohan, r.item!.id, [o3.id]);
    assert.deepEqual(p.poll!.options.map((o) => o.pct), [0, 67, 33]); assert.equal(p.poll!.voters, 3);
    await assert.rejects(engage.vote(tx, arjun, r.item!.id, [o1.id, o2.id]), /one answer/);
    const other = await engage.createPost(tx, karan, { kind: "poll", body: "Other", poll: { options: ["A", "B"], multiple: true, anonymous: false, endsAt: null } });
    await assert.rejects(engage.vote(tx, arjun, r.item!.id, [other.item!.poll!.options[0].id]), /isn't part/);
    const m = await engage.vote(tx, arjun, other.item!.id, other.item!.poll!.options.map((o) => o.id));
    assert.deepEqual(m.poll!.options.map((o) => o.mine), [true, true]);
    const admin = await engage.pollsAdmin(tx, priya);
    assert.equal(admin.find((x) => x.id === r.item!.id)!.options[1].voterNames, null, "anonymous: no names");
    assert.deepEqual(admin.find((x) => x.id === other.item!.id)!.options[0].voterNames, ["Arjun Rao"]);
    await assert.rejects(engage.pollsAdmin(tx, arjun), /access/);
    await tx`update posts set poll = jsonb_set(poll, '{ends_at}', to_jsonb((now() - interval '1 minute')::text)) where id = ${r.item!.id}`;
    await assert.rejects(engage.vote(tx, meera, r.item!.id, [o1.id]), /closed/);
    await assert.rejects(engage.createPost(tx, karan, { kind: "poll", body: "?", poll: { options: ["Same", "same"], multiple: false, anonymous: false, endsAt: null } }), /same/);
  });
  ok("polls: one vote per person (changeable), single vs multiple enforced, foreign options refused, % adds to 100, anonymous hides names, closed refuses");

  // praise
  await rolledBack(tenant.id, async (tx) => {
    await assert.rejects(engage.createPost(tx, arjun, { kind: "praise", body: "me!", praise: { recipientIds: [arjun.employeeId], badgeId: ids.badge } }), /yourself/);
    await assert.rejects(engage.createPost(tx, arjun, { kind: "praise", body: "x", praise: { recipientIds: [meera.employeeId], badgeId: randomUUID() } }), /badge/);
    const m0 = await notes(tx, meera, "engage.praise"), k0 = await notes(tx, karan, "engage.praise");
    const r = await engage.createPost(tx, arjun, { kind: "praise", body: "Great review comments", praise: { recipientIds: [meera.employeeId], badgeId: ids.badge } });
    assert.equal(r.item!.recipients[0].id, meera.employeeId); assert.ok(r.item!.badge);
    assert.equal(await notes(tx, meera, "engage.praise"), m0 + 1);
    assert.equal(await notes(tx, karan, "engage.praise"), k0);
    const onProfile = await engage.praiseFor(tx, karan, meera.employeeId);
    assert.equal(onProfile[0].id, r.item!.id); assert.equal(onProfile[0].from.name, "Arjun Rao");
    await tx`update badges set is_active = false where id = ${ids.badge}`;
    await assert.rejects(engage.createPost(tx, arjun, { kind: "praise", body: "x", praise: { recipientIds: [meera.employeeId], badgeId: ids.badge } }), /isn't available/);
  });
  ok("praise: not yourself, badge must be active, recipients notified, shows on their profile");

  // reactions and comments
  await rolledBack(tenant.id, async (tx) => {
    const r = await engage.createPost(tx, arjun, { kind: "post", body: "React to me" });
    await engage.react(tx, meera, r.item!.id, "like");
    let s = await engage.react(tx, meera, r.item!.id, "like");
    assert.equal(s.total, 1, "same reaction twice is still one");
    s = await engage.react(tx, meera, r.item!.id, "celebrate");
    assert.equal(s.total, 1); assert.equal(s.mine, "celebrate");
    await engage.react(tx, karan, r.item!.id, "like");
    s = await engage.react(tx, meera, r.item!.id, null);
    assert.equal(s.total, 1); assert.equal(s.mine, null);
    await assert.rejects(engage.addComment(tx, meera, r.item!.id, "   "), /Write a comment/);
    const c = await engage.addComment(tx, meera, r.item!.id, "Nice");
    const c2 = await engage.addComment(tx, karan, r.item!.id, "Agreed");
    const c3 = await engage.addComment(tx, rohan, r.item!.id, "+1");
    // all three share the transaction's now(); spread them out so "latest" is well defined
    for (const [i, x] of [c, c2, c3].entries()) await tx`update post_comments set created_at = now() + make_interval(secs => ${i}) where id = ${x.id}`;
    const item = (await engage.getPost(tx, arjun, r.item!.id))!;
    assert.equal(item.comments.count, 3); assert.deepEqual(item.comments.latest.map((x) => x.body), ["Agreed", "+1"]);
    assert.equal(item.comments.latest[0].canDelete, false, "post author can't delete others' comments");
    assert.equal((await engage.listComments(tx, karan, r.item!.id)).length, 3);
    await assert.rejects(engage.deleteComment(tx, karan, c.id), /your own comments/);
    await engage.deleteComment(tx, priya, c.id);   // HR moderates
    await engage.deleteComment(tx, karan, item.comments.latest[0].id);
    assert.equal((await engage.listComments(tx, arjun, r.item!.id)).length, 1);
  });
  ok("reactions: one per person, idempotent, change and remove; comments: add, latest two inline, own delete, HR moderates");

  // delete + moderation scope
  await rolledBack(tenant.id, async (tx) => {
    const r = await engage.createPost(tx, arjun, { kind: "post", body: "Delete me" });
    await assert.rejects(engage.deletePost(tx, meera, r.item!.id), /your own posts/);
    await engage.deletePost(tx, arjun, r.item!.id);
    assert.equal(await engage.getPost(tx, arjun, r.item!.id), null);
    const r2 = await engage.createPost(tx, karan, { kind: "post", body: "Moderate me" });
    await engage.deletePost(tx, priya, r2.item!.id);
    await assert.rejects(engage.deletePost(tx, priya, r2.item!.id), /removed/);
    // scoped HR: Engineering-only role with announcement access
    const [role] = await tx<{ id: string }[]>`insert into roles (tenant_id, key, name, permissions) values (${tenant.id}, 'eng_comms', 'Engineering comms', ${["engage.announce"]}) returning id`;
    await tx`insert into role_assignments (tenant_id, role_id, employee_id, scopes) values (${tenant.id}, ${role.id}, ${rohan.employeeId}, ${tx.json([{ type: "department", ids: [ids.eng] }])})`;
    const scoped: Actor = { ...rohan, permissions: new Set(["engage.announce"]), grants: [{ permissions: ["engage.announce"], scopes: [{ type: "department", ids: [ids.eng] }] }] };
    await assert.rejects(engage.createPost(tx, scoped, { kind: "announcement", title: "All hands", body: "x" }), /departments or locations you manage/);
    const ok1 = await engage.createPost(tx, scoped, { kind: "announcement", title: "Eng all hands", body: "x", audience: { type: "departments", ids: [ids.eng] } });
    assert.ok(ok1.item);
    const finPost = await engage.createPost(tx, karan, { kind: "post", body: "Finance person's post" });
    await assert.rejects(engage.deletePost(tx, scoped, finPost.item!.id), /your own posts/);
    const engPost = await engage.createPost(tx, meera, { kind: "post", body: "Engineering person's post" });
    await engage.deletePost(tx, scoped, engPost.item!.id);
    assert.ok((await engage.announcementsAdmin(tx, scoped)).every((x) => x.canManage && x.author === rohan.name), "scoped HR manages only their own announcements");
  });
  ok("delete: own posts only, HR moderates; scoped HR announces and moderates only within their departments");

  // images
  await rolledBack(tenant.id, async (tx) => {
    await assert.rejects(engage.saveImage(tx, arjun, { name: "x.svg", type: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") }), /JPG, PNG/);
    await assert.rejects(engage.saveImage(tx, arjun, { name: "x.png", type: "image/png", bytes: new TextEncoder().encode("not really a png") }), /doesn't look/);
    await assert.rejects(engage.saveImage(tx, arjun, { name: "big.png", type: "image/png", bytes: new Uint8Array(5 * 1024 * 1024 + 1).fill(0).map((_, i) => (i < 8 ? PNG[i] : 0)) }), /5 MB/);
    const f = await engage.saveImage(tx, arjun, { name: "dot.png", type: "image/png", bytes: PNG });
    const [row] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${f.id}`;
    try {
      assert.ok((await getObject(row.storage_key))?.equals(Buffer.from(PNG)), "bytes stored");
      assert.equal(await engage.imageFor(tx, meera, f.id), null, "an unattached upload is private to its uploader");
      await assert.rejects(engage.createPost(tx, meera, { kind: "post", body: "stolen", mediaFileIds: [f.id] }), /Upload the image again/);
      const r = await engage.createPost(tx, arjun, { kind: "post", body: "with a picture", mediaFileIds: [f.id], audience: { type: "departments", ids: [ids.eng] } });
      assert.equal(r.item!.media[0].url, `/engage/media/${f.id}`);
      assert.ok(await engage.imageFor(tx, meera, f.id), "Engineering can see it");
      assert.equal(await engage.imageFor(tx, karan, f.id), null, "Finance can't");
      await assert.rejects(engage.createPost(tx, arjun, { kind: "poll", body: "?", mediaFileIds: [f.id], poll: { options: ["a", "b"], multiple: false, anonymous: false, endsAt: null } }), /Images can only/);
    } finally {
      await deleteObject(row.storage_key);
    }
  });
  ok("images: SVG / fake / oversize refused by type and magic bytes, stored privately, others can't attach your upload, visibility follows the post");

  // celebrations + holidays (seeded: Meera's birthday today, Divya private)
  await withTenant(tenant.id, async (tx) => {
    const c = await engage.celebrationsFor(tx);
    const m = c.birthdays.find((x) => x.name === "Meera Iyer");
    assert.ok(m && m.isToday && m.designation === "Software Engineer");
    const d = c.birthdays.find((x) => x.name === "Divya Pillai");
    assert.ok(d && d.private && d.designation === null, "private profile shows only the name");
    assert.ok(c.newJoiners.some((x) => x.name === "Asha Verma"), "Asha joined today");
    const h = await engage.upcomingHolidays(tx, arjun.employeeId);
    assert.ok(h.length >= 1 && h.every((x) => x.date >= todayIn()));
  });
  ok("celebrations: today's birthday first, private profiles masked, new joiners; upcoming holidays from the person's list");

  // tenant isolation
  const otherId = randomUUID();
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"engage-smoke-" + otherId.slice(0, 8)}, 'Other Co')`;
  try {
    const seeded = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from posts limit 1`);
    await withTenant(otherId, async (tx) => {
      for (const table of ["posts", "poll_options", "poll_votes", "post_comments", "post_reactions", "praise_recipients", "badges"]) {
        const [{ n }] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
        assert.equal(n, 0, `${table} hidden from another tenant`);
      }
      await assert.rejects(tx.savepoint((sp) => sp`insert into posts (tenant_id, author_employee_id, kind) values (${tenant.id}, ${arjun.employeeId}, 'post')`), /row-level security/);
      const outsider: Actor = { ...arjun, tenant: { ...tenant, id: otherId } };
      await assert.rejects(engage.react(tx, outsider, seeded[0].id, "like"), /removed/);
      await assert.rejects(engage.addComment(tx, outsider, seeded[0].id, "hi"), /removed/);
      assert.equal(await engage.getPost(tx, outsider, seeded[0].id), null);
      const [{ n }] = await tx<{ n: number }[]>`update posts set body = 'hacked' where id = ${seeded[0].id} returning 1 as n`.then((r) => (r.length ? r : [{ n: 0 }]));
      assert.equal(n, 0);
    });
  } finally {
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("another tenant sees none of Acme's posts, polls, votes, comments, reactions, praise or badges, and can't write, react or comment on them");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e);
  await admin.end(); await sql.end(); process.exit(1);
});
