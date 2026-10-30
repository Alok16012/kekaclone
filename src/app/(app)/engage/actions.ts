"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as engage from "@/server/modules/engage/service";
import { LIMITS, POST_KINDS, REACTIONS } from "@/server/modules/engage/rules";

/*
 * Wall actions update the card in place on the client (optimistic UI), so they don't re-render the page.
 * Admin-list actions (pin, schedule, delete from the list) do refresh it.
 */
const uuid = z.uuid();
const quiet = { refresh: false } as const;
const bad = (msg = "Something in that form isn't right. Check it and try again.") => ({ ok: false as const, error: msg });

const audience = z.discriminatedUnion("type", [
  z.object({ type: z.literal("org") }),
  z.object({ type: z.literal("departments"), ids: z.array(uuid).max(LIMITS.audienceIds) }),
  z.object({ type: z.literal("locations"), ids: z.array(uuid).max(LIMITS.audienceIds) }),
]);
const draft = z.object({
  kind: z.enum(POST_KINDS),
  body: z.string().max(LIMITS.body + 100).nullish(),
  title: z.string().max(LIMITS.title + 50).nullish(),
  audience: audience.optional(),
  mediaFileIds: z.array(uuid).max(LIMITS.images).optional(),
  poll: z.object({ options: z.array(z.string().max(LIMITS.optionLabel + 50)).max(LIMITS.pollOptionsMax + 5), multiple: z.boolean(), anonymous: z.boolean(), endsAt: z.string().max(40).nullable() }).optional(),
  praise: z.object({ recipientIds: z.array(uuid).max(LIMITS.recipients + 5), badgeId: z.string().max(40) }).optional(),
  pinnedUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  publishAt: z.string().max(40).nullish(),
});

export async function feedPageAction(tab: engage.FeedTab, cursor: string | null) {
  const t = z.enum(["org", "department"]).safeParse(tab);
  if (!t.success) return bad();
  return runAction((tx, actor) => engage.feed(tx, actor, { tab: t.data, cursor: cursor?.slice(0, 200) ?? null }), quiet);
}

export async function createPostAction(input: z.input<typeof draft>) {
  const d = draft.safeParse(input);
  if (!d.success) return bad();
  // announcements also show in the admin list, so refresh the page for those
  return runAction((tx, actor) => engage.createPost(tx, actor, d.data), { refresh: d.data.kind === "announcement" });
}

export async function uploadImageAction(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File)) return bad("Choose an image to upload.");
  if (f.size > LIMITS.imageBytes) return bad("Images can be up to 5 MB.");
  const bytes = new Uint8Array(await f.arrayBuffer());
  return runAction((tx, actor) => engage.saveImage(tx, actor, { name: f.name, type: f.type, bytes }), quiet);
}

export async function reactAction(postId: string, kind: string | null) {
  const p = z.object({ postId: uuid, kind: z.enum(REACTIONS).nullable() }).safeParse({ postId, kind });
  if (!p.success) return bad();
  return runAction((tx, actor) => engage.react(tx, actor, p.data.postId, p.data.kind), quiet);
}

export async function commentsAction(postId: string) {
  const p = uuid.safeParse(postId);
  if (!p.success) return bad();
  return runAction((tx, actor) => engage.listComments(tx, actor, p.data), quiet);
}

export async function addCommentAction(postId: string, body: string) {
  const p = z.object({ postId: uuid, body: z.string().max(LIMITS.comment + 100) }).safeParse({ postId, body });
  if (!p.success) return bad(`Keep comments under ${LIMITS.comment} characters.`);
  return runAction((tx, actor) => engage.addComment(tx, actor, p.data.postId, p.data.body), quiet);
}

export async function deleteCommentAction(commentId: string) {
  const p = uuid.safeParse(commentId);
  if (!p.success) return bad();
  return runAction((tx, actor) => engage.deleteComment(tx, actor, p.data), quiet);
}

export async function voteAction(postId: string, optionIds: string[]) {
  const p = z.object({ postId: uuid, optionIds: z.array(uuid).max(LIMITS.pollOptionsMax) }).safeParse({ postId, optionIds });
  if (!p.success) return bad("Pick an option.");
  return runAction((tx, actor) => engage.vote(tx, actor, p.data.postId, p.data.optionIds), quiet);
}

export async function deletePostAction(postId: string, opts: { refresh?: boolean } = {}) {
  const p = uuid.safeParse(postId);
  if (!p.success) return bad();
  return runAction((tx, actor) => engage.deletePost(tx, actor, p.data), { refresh: !!opts.refresh });
}

export async function pinAction(postId: string, until: string | null) {
  const p = z.object({ postId: uuid, until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).safeParse({ postId, until });
  if (!p.success) return bad("Pick a date.");
  return runAction((tx, actor) => engage.setPin(tx, actor, p.data.postId, p.data.until));
}

export async function rescheduleAction(postId: string, at: string | null) {
  const p = z.object({ postId: uuid, at: z.string().max(40).nullable() }).safeParse({ postId, at });
  if (!p.success) return bad("Pick a date and time.");
  return runAction((tx, actor) => engage.reschedule(tx, actor, p.data.postId, p.data.at));
}
