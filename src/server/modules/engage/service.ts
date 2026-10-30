import "server-only";
import { randomUUID } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { can, canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import {
  IMAGE_EXT, LIMITS, REACTIONS, announcementStatus, celebrations, checkImage, clean, cleanOptions, decodeCursor, encodeCursor, endOfDayIST,
  monthDays, percentages, sniffImage, validateDraft, validateVote,
  type AnnouncementStatus, type Audience, type DraftInput, type PostKind, type Reaction,
} from "./rules";
import { putObject } from "./storage";
import { holidayListNameFor } from "@/server/modules/leave/service";

export const ENGAGE_PERMISSION = "engage.announce";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: AppError["code"], message: string, field?: string): never => { throw new AppError(code, message, field); };

// ---------- types the screens use ----------

export type PersonRef = { id: string; name: string };
export type CommentView = { id: string; body: string; createdAt: string; author: PersonRef; canDelete: boolean };
export type PollView = {
  multiple: boolean; anonymous: boolean; endsAt: string | null; closed: boolean; voted: boolean; voters: number; totalVotes: number;
  options: { id: string; label: string; votes: number; pct: number; mine: boolean }[];
};
export type FeedItem = {
  id: string; kind: PostKind; title: string | null; body: string | null; publishedAt: string;
  author: PersonRef & { designation: string | null };
  audience: { type: Audience["type"]; label: string };
  media: { id: string; url: string }[];
  pinned: boolean;
  badge: { name: string; icon: string } | null;
  recipients: PersonRef[];
  poll: PollView | null;
  reactions: { total: number; mine: Reaction | null; top: Reaction[] };
  comments: { count: number; latest: CommentView[] };
  canDelete: boolean;
};
export type FeedPage = { pinned: FeedItem[]; items: FeedItem[]; nextCursor: string | null; noDepartment?: boolean };
export type FeedTab = "org" | "department";

// ---------- who is looking, and what they may manage ----------

type Viewer = { id: string; departmentId: string | null; locationId: string | null };

async function viewer(tx: Tx, actor: Actor): Promise<Viewer> {
  const [e] = await tx<{ department_id: string | null; location_id: string | null }[]>`select department_id, location_id from employees where id = ${actor.employeeId}`;
  return { id: actor.employeeId, departmentId: e?.department_id ?? null, locationId: e?.location_id ?? null };
}

/** Where the actor may announce: everywhere, or only to the departments / locations their scoped role covers. */
export function announceScope(actor: Actor): { global: boolean; departments: string[]; locations: string[] } | null {
  const grants = (actor.grants ?? []).filter((g) => g.permissions.includes("*") || g.permissions.includes(ENGAGE_PERMISSION));
  if (!grants.length) return can(actor, ENGAGE_PERMISSION) && !(actor.grants ?? []).length ? { global: true, departments: [], locations: [] } : null;
  if (grants.some((g) => g.scopes.length === 0)) return { global: true, departments: [], locations: [] };
  const ids = (type: string) => [...new Set(grants.flatMap((g) => g.scopes.filter((s) => s.type === type).flatMap((s) => s.ids)))];
  return { global: false, departments: ids("department"), locations: ids("location") };
}

/** HR moderation of someone's post or comment respects role scopes (an Engineering-only HR moderates Engineering people). */
function moderates(actor: Actor, author: Placement) {
  if (!(actor.grants ?? []).length) return can(actor, ENGAGE_PERMISSION);
  return canFor(actor, ENGAGE_PERMISSION, author);
}

function audienceAllowed(scope: NonNullable<ReturnType<typeof announceScope>>, a: Audience) {
  if (scope.global) return true;
  if (a.type === "departments") return a.ids.every((id) => scope.departments.includes(id));
  if (a.type === "locations") return a.ids.every((id) => scope.locations.includes(id));
  return false;
}

// ---------- reading the wall ----------

type Row = {
  id: string; kind: PostKind; title: string | null; body: string | null; audience: Audience; media_file_ids: string[];
  poll: { multiple: boolean; anonymous: boolean; ends_at: string | null } | null; pinned_until: Date | null; publish_at: Date; cursor_at: string;
  author_employee_id: string; author_name: string; author_designation: string | null; badge_name: string | null; badge_icon: string | null;
} & { [K in keyof Placement as `author_${K}`]: string | null };

const cols = (tx: Tx) => tx`
  p.id, p.kind, p.title, p.body, p.audience, p.media_file_ids, p.poll, p.pinned_until, p.publish_at,
  to_char(p.publish_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
  p.author_employee_id, a.display_name as author_name, ad.title as author_designation,
  a.department_id as author_department_id, a.location_id as author_location_id, a.legal_entity_id as author_legal_entity_id, a.business_unit_id as author_business_unit_id,
  b.name as badge_name, b.icon as badge_icon`;
const from = (tx: Tx) => tx`posts p join employees a on a.id = p.author_employee_id left join designations ad on ad.id = a.designation_id left join badges b on b.id = p.badge_id`;

/** Live (published, not expired) posts whose audience includes the viewer; authors always see their own. */
const visibleTo = (tx: Tx, v: Viewer) => tx`
  (p.author_employee_id = ${v.id}
    or p.audience->>'type' = 'org'
    or (p.audience->>'type' = 'departments' and p.audience->'ids' @> jsonb_build_array(${v.departmentId}::text))
    or (p.audience->>'type' = 'locations' and p.audience->'ids' @> jsonb_build_array(${v.locationId}::text)))
  and p.publish_at <= now() and (p.expires_at is null or p.expires_at > now())`;

const placementOf = (r: { author_department_id: string | null; author_location_id: string | null; author_legal_entity_id: string | null; author_business_unit_id: string | null }): Placement =>
  ({ department_id: r.author_department_id, location_id: r.author_location_id, legal_entity_id: r.author_legal_entity_id, business_unit_id: r.author_business_unit_id });

/** One page of the wall. Organisation tab: company-wide posts and every announcement meant for you, pinned ones first. Department tab: posts shared with your department. */
export async function feed(tx: Tx, actor: Actor, opts: { tab: FeedTab; cursor?: string | null; limit?: number }): Promise<FeedPage> {
  const v = await viewer(tx, actor);
  const limit = Math.max(1, Math.min(opts.limit ?? LIMITS.pageSize, 30));
  const c = decodeCursor(opts.cursor);
  if (opts.cursor && !c) fail("invalid", "That page link has expired. Reload to see the latest posts.");
  if (opts.tab === "department" && !v.departmentId) return { pinned: [], items: [], nextCursor: null, noDepartment: true };
  const tab = opts.tab === "org"
    ? tx`(p.audience->>'type' <> 'departments' or p.kind = 'announcement') and not (p.pinned_until is not null and p.pinned_until > now())`
    : tx`p.audience->>'type' = 'departments' and p.audience->'ids' @> jsonb_build_array(${v.departmentId}::text)`;
  const after = c ? tx`and (p.publish_at, p.id) < (${c.at}::text::timestamptz, ${c.id}::uuid)` : tx``;
  const [rows, pinned] = await Promise.all([
    tx<Row[]>`select ${cols(tx)} from ${from(tx)} where ${visibleTo(tx, v)} and ${tab} ${after} order by p.publish_at desc, p.id desc limit ${limit + 1}`,
    opts.tab === "org" && !c
      ? tx<Row[]>`select ${cols(tx)} from ${from(tx)} where ${visibleTo(tx, v)} and p.pinned_until > now() order by p.publish_at desc, p.id desc limit 20`
      : Promise.resolve([] as Row[]),
  ]);
  const page = rows.slice(0, limit);
  const items = await hydrate(tx, actor, [...pinned, ...page]);
  const last = page[page.length - 1];
  return {
    pinned: items.slice(0, pinned.length),
    items: items.slice(pinned.length),
    nextCursor: rows.length > limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  };
}

/** One post, if the actor can see it. */
export async function getPost(tx: Tx, actor: Actor, id: string): Promise<FeedItem | null> {
  if (!UUID.test(id)) return null;
  const v = await viewer(tx, actor);
  const rows = await tx<Row[]>`select ${cols(tx)} from ${from(tx)} where p.id = ${id} and ${visibleTo(tx, v)}`;
  return (await hydrate(tx, actor, rows))[0] ?? null;
}

/** Everything a page of cards needs, in a fixed number of queries (no per-post round trips). */
async function hydrate(tx: Tx, actor: Actor, rows: Row[]): Promise<FeedItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const groupIds = [...new Set(rows.flatMap((r) => (r.audience?.type === "departments" || r.audience?.type === "locations" ? r.audience.ids : [])))].filter((x) => UUID.test(x));
  const me = actor.employeeId;
  const [recipients, options, voters, reactions, comments, groups] = await Promise.all([
    tx<{ post_id: string; id: string; name: string }[]>`
      select pr.post_id, e.id, e.display_name as name from praise_recipients pr join employees e on e.id = pr.employee_id where pr.post_id = any(${ids}::uuid[]) order by e.display_name`,
    tx<{ post_id: string; id: string; label: string; votes: number; mine: boolean }[]>`
      select o.post_id, o.id, o.label, count(v.employee_id)::int as votes, coalesce(bool_or(v.employee_id = ${me}), false) as mine
      from poll_options o left join poll_votes v on v.option_id = o.id
      where o.post_id = any(${ids}::uuid[]) group by o.id order by o.position, o.created_at`,
    tx<{ post_id: string; n: number }[]>`select post_id, count(distinct employee_id)::int as n from poll_votes where post_id = any(${ids}::uuid[]) group by post_id`,
    tx<{ post_id: string; kind: Reaction; n: number; mine: boolean }[]>`
      select post_id, kind, count(*)::int as n, bool_or(employee_id = ${me}) as mine from post_reactions where post_id = any(${ids}::uuid[]) group by post_id, kind`,
    tx<{ id: string; post_id: string; body: string; created_at: Date; author_employee_id: string; author_name: string; n: number; author_department_id: string | null; author_location_id: string | null; author_legal_entity_id: string | null; author_business_unit_id: string | null }[]>`
      select * from (
        select c.id, c.post_id, c.body, c.created_at, c.author_employee_id, e.display_name as author_name,
          e.department_id as author_department_id, e.location_id as author_location_id, e.legal_entity_id as author_legal_entity_id, e.business_unit_id as author_business_unit_id,
          row_number() over (partition by c.post_id order by c.created_at desc, c.id desc) as rn, count(*) over (partition by c.post_id)::int as n
        from post_comments c join employees e on e.id = c.author_employee_id where c.post_id = any(${ids}::uuid[])
      ) x where rn <= 2 order by created_at, id`,
    groupIds.length
      ? tx<{ id: string; name: string }[]>`select id, name from departments where id = any(${groupIds}::uuid[]) union all select id, name from locations where id = any(${groupIds}::uuid[])`
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const now = Date.now();
  return rows.map((r) => {
    const a = r.audience ?? { type: "org" };
    const label = a.type === "org" ? "Everyone" : a.ids.map((id) => groupName.get(id)).filter(Boolean).join(", ") || (a.type === "departments" ? "Departments" : "Locations");
    const opts = options.filter((o) => o.post_id === r.id);
    const pct = percentages(opts.map((o) => o.votes));
    const rx = reactions.filter((x) => x.post_id === r.id).sort((x, y) => y.n - x.n);
    const cm = comments.filter((x) => x.post_id === r.id);
    const endsAt = r.poll?.ends_at ?? null;
    return {
      id: r.id, kind: r.kind, title: r.title, body: r.body, publishedAt: r.publish_at.toISOString(),
      author: { id: r.author_employee_id, name: r.author_name, designation: r.author_designation },
      audience: { type: a.type, label },
      media: (r.media_file_ids ?? []).map((id) => ({ id, url: `/engage/media/${id}` })),
      pinned: !!r.pinned_until && r.pinned_until.getTime() > now,
      badge: r.badge_name ? { name: r.badge_name, icon: r.badge_icon ?? "award" } : null,
      recipients: recipients.filter((x) => x.post_id === r.id).map((x) => ({ id: x.id, name: x.name })),
      poll: r.kind === "poll" && r.poll ? {
        multiple: !!r.poll.multiple, anonymous: !!r.poll.anonymous, endsAt, closed: !!endsAt && Date.parse(endsAt) <= now,
        voted: opts.some((o) => o.mine), voters: voters.find((x) => x.post_id === r.id)?.n ?? 0, totalVotes: opts.reduce((s, o) => s + o.votes, 0),
        options: opts.map((o, i) => ({ id: o.id, label: o.label, votes: o.votes, pct: pct[i], mine: o.mine })),
      } : null,
      reactions: { total: rx.reduce((s, x) => s + x.n, 0), mine: rx.find((x) => x.mine)?.kind ?? null, top: rx.slice(0, 3).map((x) => x.kind) },
      comments: {
        count: cm[0]?.n ?? 0,
        latest: cm.map((x) => ({ id: x.id, body: x.body, createdAt: x.created_at.toISOString(), author: { id: x.author_employee_id, name: x.author_name }, canDelete: x.author_employee_id === me || moderates(actor, placementOf(x)) })),
      },
      canDelete: r.author_employee_id === me || moderates(actor, placementOf(r)),
    };
  });
}

// ---------- writing ----------

function normaliseAudience(a: Audience | undefined): Audience {
  if (!a || a.type === "org") return { type: "org" };
  const ids = [...new Set(a.ids)];
  if (ids.some((id) => !UUID.test(id))) fail("invalid", "Pick the audience again.", "audience");
  return { type: a.type, ids };
}

/** Create a post, announcement, poll or praise. Returns the card (null when an announcement is scheduled for later). */
export async function createPost(tx: Tx, actor: Actor, d: DraftInput): Promise<{ item: FeedItem | null; scheduledFor: string | null }> {
  const now = new Date();
  const problem = validateDraft(d, { authorId: actor.employeeId, now, today: todayIn() });
  if (problem) fail("invalid", problem.message, problem.field);
  const audience = normaliseAudience(d.audience);
  const v = await viewer(tx, actor);

  if (d.kind === "announcement") {
    const scope = announceScope(actor);
    if (!scope) fail("forbidden", "Only people with announcement access can post announcements.");
    if (!audienceAllowed(scope!, audience)) fail("forbidden", "You can only announce to the departments or locations you manage.", "audience");
  } else if (audience.type === "departments") {
    const own = audience.ids.length === 1 && audience.ids[0] === v.departmentId;
    if (!own && !announceScope(actor)?.global) fail("forbidden", "Share with everyone or with your own department.", "audience");
  }
  if (audience.type !== "org") {
    const [{ n }] = audience.type === "departments"
      ? await tx<{ n: number }[]>`select count(*)::int as n from departments where id = any(${audience.ids}::uuid[])`
      : await tx<{ n: number }[]>`select count(*)::int as n from locations where id = any(${audience.ids}::uuid[])`;
    if (n !== audience.ids.length) fail("invalid", "One of the groups you picked no longer exists.", "audience");
  }

  const media = [...new Set(d.mediaFileIds ?? [])];
  if (media.length) {
    if (media.some((id) => !UUID.test(id))) fail("invalid", "Upload the image again.", "media");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from files where id = any(${media}::uuid[]) and uploaded_by = ${actor.userId} and mime like 'image/%'`;
    if (n !== media.length) fail("invalid", "Upload the image again.", "media");
  }

  let badgeId: string | null = null;
  if (d.kind === "praise") {
    const pr = d.praise!;
    if (!UUID.test(pr.badgeId) || pr.recipientIds.some((id) => !UUID.test(id))) fail("invalid", "Pick the people and badge again.");
    const [b] = await tx<{ id: string }[]>`select id from badges where id = ${pr.badgeId} and is_active`;
    if (!b) fail("invalid", "That badge isn't available any more.", "badge");
    badgeId = b.id;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees where id = any(${pr.recipientIds}::uuid[]) and status <> 'relieved'`;
    if (n !== pr.recipientIds.length) fail("invalid", "Someone you picked has left the company.", "recipients");
  }

  const publishAt = d.kind === "announcement" && d.publishAt && Date.parse(d.publishAt) > now.getTime() ? new Date(d.publishAt) : null;
  const pinnedUntil = d.kind === "announcement" && d.pinnedUntil ? endOfDayIST(d.pinnedUntil) : null;
  const poll = d.kind === "poll" ? { multiple: !!d.poll!.multiple, anonymous: !!d.poll!.anonymous, ends_at: d.poll!.endsAt ? new Date(d.poll!.endsAt).toISOString() : null } : null;
  const [post] = await tx<{ id: string; live: boolean }[]>`
    insert into posts (tenant_id, author_employee_id, kind, audience, title, body, media_file_ids, badge_id, poll, pinned_until, publish_at, notified_at)
    values (${actor.tenant.id}, ${actor.employeeId}, ${d.kind}, ${tx.json(audience)}, ${d.kind === "announcement" ? clean(d.title) : null}, ${clean(d.body)},
      ${media}::uuid[], ${badgeId}, ${poll ? tx.json(poll) : null}, ${pinnedUntil}, coalesce(${publishAt}::timestamptz, now()),
      ${d.kind === "announcement" ? null : tx`now()`})
    returning id, publish_at <= now() as live`;

  if (d.kind === "poll") {
    const opts = cleanOptions(d.poll!.options);
    await tx`insert into poll_options (tenant_id, post_id, label, position)
             select ${actor.tenant.id}, ${post.id}, label, ord::int - 1 from unnest(${opts}::text[]) with ordinality as t(label, ord)`;
  }
  if (d.kind === "praise") {
    const ids = d.praise!.recipientIds;
    await tx`insert into praise_recipients (tenant_id, post_id, employee_id) select ${actor.tenant.id}, ${post.id}, unnest(${ids}::uuid[])`;
    const [badge] = await tx<{ name: string }[]>`select name from badges where id = ${badgeId}`;
    await tx`insert into notifications (tenant_id, user_id, kind, title, body, link)
             select ${actor.tenant.id}, e.user_id, 'engage.praise', ${`${actor.name} praised you`}, ${`${badge.name}: ${clean(d.body)!.slice(0, 140)}`}, '/people/' || e.id::text
             from employees e where e.id = any(${ids}::uuid[]) and e.user_id is not null`;
  }
  if (d.kind === "announcement") await publishDue(tx, actor.tenant.id);

  return { item: post.live ? await getPost(tx, actor, post.id) : null, scheduledFor: publishAt ? publishAt.toISOString() : null };
}

/**
 * Announcements that have reached their publish time and haven't been sent yet: claim them (row locks make this
 * exactly-once even if two requests race) and notify their audience with one insert each. Called after creating or
 * rescheduling, when Home or the admin list loads, and by a background job in production.
 */
export async function publishDue(tx: Tx, tenantId: string) {
  const due = await tx<{ id: string; title: string | null; author_employee_id: string; audience: Audience }[]>`
    update posts set notified_at = now() where kind = 'announcement' and notified_at is null and publish_at <= now()
    returning id, title, author_employee_id, audience`;
  let sent = 0;
  for (const p of due) {
    const a = p.audience ?? { type: "org" };
    const ids = a.type === "org" ? [] : a.ids.filter((x) => UUID.test(x));
    const r = await tx`
      insert into notifications (tenant_id, user_id, kind, title, body, link)
      select ${tenantId}, e.user_id, 'engage.announcement', 'New announcement', ${p.title ?? "Announcement"}, '/home'
      from employees e
      where e.user_id is not null and e.status <> 'relieved' and e.id <> ${p.author_employee_id}
        and (${a.type} = 'org'
          or (${a.type} = 'departments' and e.department_id = any(${ids}::uuid[]))
          or (${a.type} = 'locations' and e.location_id = any(${ids}::uuid[])))`;
    sent += r.count;
  }
  return { posts: due.length, notified: sent };
}

type PostMeta = { id: string; kind: PostKind; author_employee_id: string; notified_at: Date | null; publish_at: Date } & { [K in keyof Placement as `author_${K}`]: string | null };
async function postMeta(tx: Tx, id: string): Promise<PostMeta> {
  if (!UUID.test(id)) fail("not_found", "That post has been removed.");
  const [p] = await tx<PostMeta[]>`
    select p.id, p.kind, p.author_employee_id, p.notified_at, p.publish_at,
      a.department_id as author_department_id, a.location_id as author_location_id, a.legal_entity_id as author_legal_entity_id, a.business_unit_id as author_business_unit_id
    from posts p join employees a on a.id = p.author_employee_id where p.id = ${id}`;
  if (!p) fail("not_found", "That post has been removed.");
  return p;
}

async function assertVisible(tx: Tx, actor: Actor, id: string) {
  if (!UUID.test(id)) fail("not_found", "That post has been removed.");
  const v = await viewer(tx, actor);
  const [p] = await tx<{ id: string; kind: PostKind; poll: Row["poll"] }[]>`select p.id, p.kind, p.poll from posts p where p.id = ${id} and ${visibleTo(tx, v)}`;
  if (!p) fail("not_found", "That post has been removed.");
  return p;
}

/** Authors delete their own posts; people with announcement access moderate (within their role's scope). */
export async function deletePost(tx: Tx, actor: Actor, id: string) {
  const p = await postMeta(tx, id);
  if (p.author_employee_id !== actor.employeeId && !moderates(actor, placementOf(p))) fail("forbidden", "You can only delete your own posts.");
  await tx`delete from posts where id = ${id}`;
}

/** Set, change or remove (kind null) the actor's reaction. Idempotent. */
export async function react(tx: Tx, actor: Actor, postId: string, kind: Reaction | null) {
  if (kind && !REACTIONS.includes(kind)) fail("invalid", "Pick a reaction.");
  await assertVisible(tx, actor, postId);
  if (kind) {
    await tx`insert into post_reactions (tenant_id, post_id, employee_id, kind) values (${actor.tenant.id}, ${postId}, ${actor.employeeId}, ${kind})
             on conflict (post_id, employee_id) do update set kind = excluded.kind`;
  } else {
    await tx`delete from post_reactions where post_id = ${postId} and employee_id = ${actor.employeeId}`;
  }
  const rx = await tx<{ kind: Reaction; n: number; mine: boolean }[]>`
    select kind, count(*)::int as n, bool_or(employee_id = ${actor.employeeId}) as mine from post_reactions where post_id = ${postId} group by kind order by n desc`;
  return { total: rx.reduce((s, x) => s + x.n, 0), mine: rx.find((x) => x.mine)?.kind ?? null, top: rx.slice(0, 3).map((x) => x.kind) };
}

type CommentRow = { id: string; body: string; created_at: Date; author_employee_id: string; author_name: string } & { [K in keyof Placement as `author_${K}`]: string | null };
const commentView = (actor: Actor, c: CommentRow): CommentView => ({
  id: c.id, body: c.body, createdAt: c.created_at.toISOString(), author: { id: c.author_employee_id, name: c.author_name },
  canDelete: c.author_employee_id === actor.employeeId || moderates(actor, placementOf(c)),
});

export async function listComments(tx: Tx, actor: Actor, postId: string): Promise<CommentView[]> {
  await assertVisible(tx, actor, postId);
  const rows = await tx<CommentRow[]>`
    select c.id, c.body, c.created_at, c.author_employee_id, e.display_name as author_name,
      e.department_id as author_department_id, e.location_id as author_location_id, e.legal_entity_id as author_legal_entity_id, e.business_unit_id as author_business_unit_id
    from post_comments c join employees e on e.id = c.author_employee_id where c.post_id = ${postId} order by c.created_at, c.id limit 200`;
  return rows.map((c) => commentView(actor, c));
}

export async function addComment(tx: Tx, actor: Actor, postId: string, body: string): Promise<CommentView> {
  const text = clean(body);
  if (!text) fail("invalid", "Write a comment first.", "comment");
  if (text!.length > LIMITS.comment) fail("invalid", `Keep comments under ${LIMITS.comment} characters.`, "comment");
  await assertVisible(tx, actor, postId);
  const [c] = await tx<{ id: string; created_at: Date }[]>`
    insert into post_comments (tenant_id, post_id, author_employee_id, body) values (${actor.tenant.id}, ${postId}, ${actor.employeeId}, ${text}) returning id, created_at`;
  return { id: c.id, body: text!, createdAt: c.created_at.toISOString(), author: { id: actor.employeeId, name: actor.name }, canDelete: true };
}

export async function deleteComment(tx: Tx, actor: Actor, commentId: string) {
  if (!UUID.test(commentId)) fail("not_found", "That comment has been removed.");
  const [c] = await tx<CommentRow[]>`
    select c.id, c.body, c.created_at, c.author_employee_id, e.display_name as author_name,
      e.department_id as author_department_id, e.location_id as author_location_id, e.legal_entity_id as author_legal_entity_id, e.business_unit_id as author_business_unit_id
    from post_comments c join employees e on e.id = c.author_employee_id where c.id = ${commentId}`;
  if (!c) fail("not_found", "That comment has been removed.");
  if (!commentView(actor, c).canDelete) fail("forbidden", "You can only delete your own comments.");
  await tx`delete from post_comments where id = ${commentId}`;
}

/** Vote (or change your vote) until the poll closes. Replaces the actor's previous choices. */
export async function vote(tx: Tx, actor: Actor, postId: string, optionIds: string[]): Promise<FeedItem> {
  const p = await assertVisible(tx, actor, postId);
  if (p.kind !== "poll" || !p.poll) fail("invalid", "That post isn't a poll.");
  await tx`select pg_advisory_xact_lock(hashtext(${postId + actor.employeeId}))`;   // one vote change at a time per person per poll
  const opts = await tx<{ id: string }[]>`select id from poll_options where post_id = ${postId}`;
  const problem = validateVote(optionIds, { multiple: !!p.poll!.multiple, optionIds: opts.map((o) => o.id), endsAt: p.poll!.ends_at }, new Date());
  if (problem) fail("invalid", problem.message);
  await tx`delete from poll_votes where post_id = ${postId} and employee_id = ${actor.employeeId}`;
  await tx`insert into poll_votes (tenant_id, option_id, employee_id, post_id) select ${actor.tenant.id}, unnest(${optionIds}::uuid[]), ${actor.employeeId}, ${postId}`;
  return (await getPost(tx, actor, postId))!;
}

// ---------- images ----------

/** Store an uploaded wall image after checking size, type and contents. At most 30 uploads an hour per person. */
export async function saveImage(tx: Tx, actor: Actor, f: { name: string; type: string; bytes: Uint8Array }) {
  const sniffed = sniffImage(f.bytes.subarray(0, 16));
  const problem = checkImage({ size: f.bytes.byteLength, declared: f.type, sniffed });
  if (problem) fail("invalid", problem.message, "media");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from files where uploaded_by = ${actor.userId} and created_at > now() - interval '1 hour'`;
  if (n >= 30) fail("conflict", "You've uploaded a lot of images in the last hour. Try again a little later.", "media");
  const id = randomUUID();
  const key = `${actor.tenant.id}/${id}.${IMAGE_EXT[sniffed!]}`;
  await tx`insert into files (id, tenant_id, storage_key, name, mime, size_bytes, uploaded_by, scan_status)
           values (${id}, ${actor.tenant.id}, ${key}, ${f.name.slice(0, 200) || "image"}, ${sniffed}, ${f.bytes.byteLength}, ${actor.userId}, 'clean')`;
  await putObject(key, f.bytes);
  return { id, url: `/engage/media/${id}` };
}

/** Storage key of an image the actor may see: one they uploaded, or one on a post visible to them. */
export async function imageFor(tx: Tx, actor: Actor, fileId: string) {
  if (!UUID.test(fileId)) return null;
  const v = await viewer(tx, actor);
  const [f] = await tx<{ storage_key: string; mime: string }[]>`
    select f.storage_key, f.mime from files f where f.id = ${fileId} and f.mime like 'image/%'
      and (f.uploaded_by = ${actor.userId} or exists (select 1 from posts p where ${fileId}::uuid = any(p.media_file_ids) and ${visibleTo(tx, v)}))`;
  return f ?? null;
}

// ---------- HR: announcements and polls ----------

export type AnnouncementRow = {
  id: string; title: string; body: string; audience: string; author: string; publishAt: string; pinnedUntil: string | null;
  status: AnnouncementStatus; pinned: boolean; reactions: number; comments: number; canManage: boolean;
};

function assertModerator(actor: Actor) {
  const scope = announceScope(actor);
  if (!scope) fail("forbidden", "You don't have access to manage announcements.");
  return scope!;
}

export async function announcementsAdmin(tx: Tx, actor: Actor): Promise<AnnouncementRow[]> {
  const scope = assertModerator(actor);
  await publishDue(tx, actor.tenant.id);
  const rows = await tx<{ id: string; title: string | null; body: string | null; audience: Audience; author_employee_id: string; author: string; publish_at: Date; pinned_until: Date | null; expires_at: Date | null; reactions: number; comments: number }[]>`
    select p.id, p.title, p.body, p.audience, p.author_employee_id, a.display_name as author, p.publish_at, p.pinned_until, p.expires_at,
      (select count(*)::int from post_reactions r where r.post_id = p.id) as reactions, (select count(*)::int from post_comments c where c.post_id = p.id) as comments
    from posts p join employees a on a.id = p.author_employee_id
    where p.kind = 'announcement' and (${scope.global} or p.author_employee_id = ${actor.employeeId})
    order by (p.publish_at > now()) desc, p.publish_at desc limit 200`;
  const groupIds = [...new Set(rows.flatMap((r) => (r.audience.type === "org" ? [] : r.audience.ids)))].filter((x) => UUID.test(x));
  const groups = groupIds.length ? await tx<{ id: string; name: string }[]>`select id, name from departments where id = any(${groupIds}::uuid[]) union all select id, name from locations where id = any(${groupIds}::uuid[])` : [];
  const name = new Map(groups.map((g) => [g.id, g.name]));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id, title: r.title ?? "Announcement", body: r.body ?? "", author: r.author,
    audience: r.audience.type === "org" ? "Everyone" : r.audience.ids.map((i) => name.get(i)).filter(Boolean).join(", "),
    publishAt: r.publish_at.toISOString(), pinnedUntil: r.pinned_until?.toISOString() ?? null,
    status: announcementStatus(r.publish_at, r.expires_at, now), pinned: !!r.pinned_until && r.pinned_until > now,
    reactions: r.reactions, comments: r.comments, canManage: scope.global || r.author_employee_id === actor.employeeId,
  }));
}

async function manageableAnnouncement(tx: Tx, actor: Actor, id: string) {
  const scope = assertModerator(actor);
  const p = await postMeta(tx, id);
  if (p.kind !== "announcement") fail("invalid", "Only announcements can be pinned or scheduled.");
  if (!scope.global && p.author_employee_id !== actor.employeeId) fail("forbidden", "You can only manage your own announcements.");
  return p;
}

/** Pin through the end of a day (IST), or unpin with null. */
export async function setPin(tx: Tx, actor: Actor, id: string, until: ISODate | null) {
  await manageableAnnouncement(tx, actor, id);
  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < todayIn()) fail("invalid", "Pick today or a later date.", "pinnedUntil");
    if (until > addDaysISO(todayIn(), 366)) fail("invalid", "Pin for at most a year.", "pinnedUntil");
  }
  await tx`update posts set pinned_until = ${until ? endOfDayIST(until) : null} where id = ${id}`;
}

/** Move a scheduled announcement (or publish it now with `at` = null). Live ones can't be un-sent. */
export async function reschedule(tx: Tx, actor: Actor, id: string, at: string | null) {
  const p = await manageableAnnouncement(tx, actor, id);
  if (p.notified_at) fail("conflict", "This announcement is already live.");
  let when: Date | null = null;
  if (at) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) fail("invalid", "Pick a valid date and time.", "publishAt");
    if (t < Date.now() - 5 * 60_000) fail("invalid", "Pick a time in the future.", "publishAt");
    if (t > Date.now() + 366 * 864e5) fail("invalid", "Schedule at most a year ahead.", "publishAt");
    when = new Date(t);
  }
  await tx`update posts set publish_at = coalesce(${when}::timestamptz, now()) where id = ${id}`;
  return publishDue(tx, actor.tenant.id);
}

export type PollAdminRow = {
  id: string; question: string; author: string; publishedAt: string; endsAt: string | null; closed: boolean; anonymous: boolean; multiple: boolean;
  voters: number; audienceSize: number; options: { id: string; label: string; votes: number; pct: number; voterNames: string[] | null }[];
};

/** Every poll with its results. Names of voters are only shown for polls that weren't anonymous. */
export async function pollsAdmin(tx: Tx, actor: Actor): Promise<PollAdminRow[]> {
  const scope = assertModerator(actor);
  const polls = await tx<{ id: string; body: string | null; author: string; publish_at: Date; poll: Row["poll"]; audience: Audience }[]>`
    select p.id, p.body, a.display_name as author, p.publish_at, p.poll, p.audience from posts p join employees a on a.id = p.author_employee_id
    where p.kind = 'poll' and (${scope.global} or p.author_employee_id = ${actor.employeeId}) order by p.publish_at desc limit 100`;
  if (!polls.length) return [];
  const ids = polls.map((p) => p.id);
  const [options, voters, [{ headcount }], deptSizes] = await Promise.all([
    tx<{ post_id: string; id: string; label: string; votes: number; names: string[] | null }[]>`
      select o.post_id, o.id, o.label, count(v.employee_id)::int as votes,
        array_remove(array_agg(e.display_name order by e.display_name), null) as names
      from poll_options o left join poll_votes v on v.option_id = o.id left join employees e on e.id = v.employee_id
      where o.post_id = any(${ids}::uuid[]) group by o.id order by o.position, o.created_at`,
    tx<{ post_id: string; n: number }[]>`select post_id, count(distinct employee_id)::int as n from poll_votes where post_id = any(${ids}::uuid[]) group by post_id`,
    tx<{ headcount: number }[]>`select count(*)::int as headcount from employees where status <> 'relieved'`,
    tx<{ id: string; n: number }[]>`select department_id as id, count(*)::int as n from employees where status <> 'relieved' and department_id is not null group by department_id`,
  ]);
  const now = Date.now();
  return polls.map((p) => {
    const opts = options.filter((o) => o.post_id === p.id);
    const pct = percentages(opts.map((o) => o.votes));
    const anonymous = !!p.poll?.anonymous;
    const endsAt = p.poll?.ends_at ?? null;
    const audienceSize = p.audience.type === "departments" ? p.audience.ids.reduce((s, id) => s + (deptSizes.find((d) => d.id === id)?.n ?? 0), 0) : headcount;
    return {
      id: p.id, question: p.body ?? "", author: p.author, publishedAt: p.publish_at.toISOString(), endsAt, closed: !!endsAt && Date.parse(endsAt) <= now,
      anonymous, multiple: !!p.poll?.multiple, voters: voters.find((x) => x.post_id === p.id)?.n ?? 0, audienceSize,
      options: opts.map((o, i) => ({ id: o.id, label: o.label, votes: o.votes, pct: pct[i], voterNames: anonymous ? null : o.names ?? [] })),
    };
  });
}

// ---------- profile + Home widgets ----------

export type PraiseReceived = { id: string; from: PersonRef; badge: { name: string; icon: string } | null; message: string; at: string; others: number };

/** Praise this person received that the viewer is allowed to see (newest first). */
export async function praiseFor(tx: Tx, actor: Actor, employeeId: string, limit = 20): Promise<PraiseReceived[]> {
  if (!UUID.test(employeeId)) return [];
  const v = await viewer(tx, actor);
  const rows = await tx<{ id: string; author_employee_id: string; author_name: string; badge_name: string | null; badge_icon: string | null; body: string | null; publish_at: Date; others: number }[]>`
    select p.id, p.author_employee_id, a.display_name as author_name, b.name as badge_name, b.icon as badge_icon, p.body, p.publish_at,
      (select count(*)::int - 1 from praise_recipients x where x.post_id = p.id) as others
    from praise_recipients pr join posts p on p.id = pr.post_id join employees a on a.id = p.author_employee_id left join badges b on b.id = p.badge_id
    where pr.employee_id = ${employeeId} and p.kind = 'praise' and ${visibleTo(tx, v)}
    order by p.publish_at desc limit ${limit}`;
  return rows.map((r) => ({ id: r.id, from: { id: r.author_employee_id, name: r.author_name }, badge: r.badge_name ? { name: r.badge_name, icon: r.badge_icon ?? "award" } : null, message: r.body ?? "", at: r.publish_at.toISOString(), others: r.others }));
}

/** Birthdays and anniversaries over the next 7 days and recent joiners, with private profiles reduced to a name. */
export async function celebrationsFor(tx: Tx, today: ISODate = todayIn()) {
  const mds = monthDays(today, 7);
  const rows = await tx<{ id: string; name: string; designation: string | null; dob: string | null; joining_date: string; is_private: boolean }[]>`
    select e.id, e.display_name as name, d.title as designation, e.dob::text, e.joining_date::text, e.is_private
    from employees e left join designations d on d.id = e.designation_id
    where e.status in ('active', 'notice')
      and (to_char(e.dob, 'MM-DD') = any(${mds}::text[]) or to_char(e.joining_date, 'MM-DD') = any(${mds}::text[])
        or e.joining_date between ${addDaysISO(today, -13)}::date and ${today}::date)`;
  return celebrations(rows, today, 7);
}

/**
 * Next holidays from the person's holiday calendar, resolved the way the leave module does it (their list, else their
 * location's, else the company's first; lists sharing a name continue across years). Optional days are marked.
 */
export async function upcomingHolidays(tx: Tx, employeeId: string, today: ISODate = todayIn(), limit = 5) {
  const list = await holidayListNameFor(tx, employeeId);
  if (!list) return [];
  return tx<{ id: string; name: string; date: string; is_floater: boolean }[]>`
    select h.id, h.name, h.date::text, h.is_floater from holidays h join holiday_lists hl on hl.id = h.holiday_list_id
    where hl.name = ${list} and h.date >= ${today}::date
    order by h.date, h.name limit ${limit}`;
}

export type ComposerOptions = {
  badges: { id: string; name: string; icon: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  myDepartment: { id: string; name: string } | null;
  announce: { global: boolean; departments: string[]; locations: string[] } | null;
};

export async function composerOptions(tx: Tx, actor: Actor): Promise<ComposerOptions> {
  const [badges, departments, locations, [me]] = await Promise.all([
    tx<{ id: string; name: string; icon: string }[]>`select id, name, icon from badges where is_active order by name`,
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string | null; name: string | null }[]>`select d.id, d.name from employees e left join departments d on d.id = e.department_id where e.id = ${actor.employeeId}`,
  ]);
  return { badges, departments, locations, myDepartment: me?.id ? { id: me.id, name: me.name! } : null, announce: announceScope(actor) };
}
