"use client";
import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, Ellipsis, Heart, Lightbulb, Megaphone, MessageCircle, PartyPopper, Pin, Send, ThumbsUp, Trash, Users, type LucideIcon } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Card } from "@/ui/card";
import { Checkbox } from "@/ui/choice";
import { ConfirmDialog, Menu, Popover } from "@/ui/overlay";
import { Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { LIMITS, type Reaction } from "@/server/modules/engage/rules";
import type { CommentView, FeedItem } from "@/server/modules/engage/service";
import { addCommentAction, commentsAction, deleteCommentAction, deletePostAction, reactAction, voteAction } from "@/app/(app)/engage/actions";
import { BadgeIcon } from "./badge-icon";
import { ago, fmtDateTime, useNow } from "./use-now";

export const REACTION_META: Record<Reaction, { label: string; icon: LucideIcon }> = {
  like: { label: "Like", icon: ThumbsUp },
  celebrate: { label: "Celebrate", icon: PartyPopper },
  love: { label: "Love", icon: Heart },
  insightful: { label: "Insightful", icon: Lightbulb },
};

export type CardMe = { id: string; name: string };
export type ItemUpdate = (fn: (prev: FeedItem) => FeedItem) => void;

/** One wall card: post, announcement, poll or praise, with reactions and comments. Updates are optimistic and reported back via onChange. */
export function PostCard({ item, me, onChange, onDeleted }: { item: FeedItem; me: CardMe; onChange: ItemUpdate; onDeleted: (id: string) => void }) {
  const now = useNow();
  const [confirm, setConfirm] = React.useState(false);
  const isAnn = item.kind === "announcement";
  const headingId = `post-${item.id}-heading`;

  return (
    <Card className={cn("overflow-hidden", item.pinned && "border-accent/40")}>
      <article aria-labelledby={headingId} className="flex flex-col">
        {(item.pinned || isAnn) && (
          <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-5 py-2 text-sm text-text-muted">
            {isAnn && <span className="inline-flex items-center gap-1.5 font-medium text-text"><Megaphone className="size-4 text-accent-text" aria-hidden />Announcement</span>}
            {item.pinned && <Badge tone="accent"><Pin aria-hidden />Pinned</Badge>}
          </div>
        )}
        <header className="flex items-start gap-3 px-5 pt-4">
          <Link href={`/people/${item.author.id}`} className="shrink-0 rounded-pill" tabIndex={-1} aria-hidden><Avatar name={item.author.name} /></Link>
          <div className="min-w-0 flex-1">
            <p id={headingId} className="text-base">
              <Link href={`/people/${item.author.id}`} className="font-semibold hover:underline">{item.author.name}</Link>
              {item.kind === "praise" && item.recipients.length > 0 && (
                <span className="text-text-muted"> praised {item.recipients.map((r, i) => (
                  <React.Fragment key={r.id}>{i > 0 && (i === item.recipients.length - 1 ? " and " : ", ")}<Link href={`/people/${r.id}`} className="font-semibold text-text hover:underline">{r.name}</Link></React.Fragment>
                ))}</span>
              )}
              {item.kind === "poll" && <span className="text-text-muted"> asked a question</span>}
            </p>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
              {item.author.designation && <span className="truncate">{item.author.designation} ·</span>}
              <time dateTime={item.publishedAt} title={fmtDateTime(item.publishedAt)}>{ago(item.publishedAt, now)}</time>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1"><Users className="size-3.5" aria-hidden /><span className="sr-only">Shared with </span>{item.audience.label}</span>
            </p>
          </div>
          {item.canDelete && (
            <Menu trigger={<IconButton label="Post options" size="icon-sm"><Ellipsis /></IconButton>}
              items={[{ label: item.author.id === me.id ? "Delete post" : "Remove post", icon: <Trash />, danger: true, onSelect: () => setConfirm(true) }]} />
          )}
        </header>

        <div className="flex flex-col gap-3 px-5 pt-3">
          {isAnn && item.title && <h3 className="text-md font-semibold">{item.title}</h3>}
          {item.kind === "praise" && item.badge && (
            <div className="flex items-center gap-3 rounded-md bg-accent-soft/50 px-4 py-3">
              <BadgeIcon icon={item.badge.icon} size="lg" />
              <div><p className="text-xs font-medium uppercase tracking-wide text-accent-text">Badge</p><p className="text-md font-semibold">{item.badge.name}</p></div>
            </div>
          )}
          {item.body && <p className={cn("whitespace-pre-line break-words text-base", item.kind === "poll" && "font-medium")}>{item.body}</p>}
          {item.media.length > 0 && (
            <div className={cn("grid gap-1.5 overflow-hidden rounded-md", item.media.length > 1 && "grid-cols-2")}>
              {item.media.map((m) => (
                // eslint-disable-next-line @next/next/no-img-element -- private, permission-checked images served by our own route
                <img key={m.id} src={m.url} alt={`Image shared by ${item.author.name}`} loading="lazy" className="max-h-96 w-full bg-surface-sunken object-cover" />
              ))}
            </div>
          )}
          {item.poll && <PollBlock item={item} onChange={onChange} now={now} />}
        </div>

        <Reactions item={item} onChange={onChange} />
        <Comments item={item} me={me} onChange={onChange} now={now} />
      </article>

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={item.author.id === me.id ? "Delete this post?" : "Remove this post?"}
        description={item.author.id === me.id ? "It disappears from the wall along with its comments and reactions." : `This removes ${item.author.name}'s post for everyone.`}
        confirmLabel={item.author.id === me.id ? "Delete" : "Remove"}
        onConfirm={async () => {
          const r = await deletePostAction(item.id);
          if (!r.ok) { toast.error(r.error); return; }
          onDeleted(item.id);
          toast.success("Post deleted");
        }} />
    </Card>
  );
}

function PollBlock({ item, onChange, now }: { item: FeedItem; onChange: ItemUpdate; now: number | null }) {
  const poll = item.poll!;
  const [picked, setPicked] = React.useState<string[]>([]);
  const [changing, setChanging] = React.useState(false);
  const [busy, start] = React.useTransition();
  const showResults = poll.closed || (poll.voted && !changing);
  const ends = poll.endsAt ? (poll.closed ? `Closed ${ago(poll.endsAt, now)}` : `Closes ${fmtDateTime(poll.endsAt)}`) : "No end date";
  const groupId = `poll-${item.id}`;

  const submit = () => start(async () => {
    const r = await voteAction(item.id, picked);
    if (!r.ok) { toast.error(r.error); return; }
    onChange(() => r.data!);
    setChanging(false); setPicked([]);
  });

  return (
    <div className="flex flex-col gap-2">
      {showResults ? (
        <ul className="flex flex-col gap-2" aria-label="Poll results">
          {poll.options.map((o) => (
            <li key={o.id} className="relative overflow-hidden rounded-md border border-border">
              <div aria-hidden className={cn("absolute inset-y-0 left-0 transition-[width] duration-slow", o.mine ? "bg-accent-soft" : "bg-surface-hover")} style={{ width: `${o.pct}%` }} />
              <div className="relative flex items-center justify-between gap-3 px-3 py-2 text-base">
                <span className="flex min-w-0 items-center gap-2">
                  {o.mine && <Check className="size-4 shrink-0 text-accent-text" aria-label="Your vote" />}
                  <span className="break-words">{o.label}</span>
                </span>
                <span className="shrink-0 font-semibold tabular">{o.pct}%<span className="sr-only">, {o.votes} {o.votes === 1 ? "vote" : "votes"}</span></span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <fieldset className="flex flex-col gap-2" aria-describedby={`${groupId}-hint`}>
          <legend className="sr-only">{item.body}</legend>
          {poll.options.map((o) => {
            const checked = picked.includes(o.id);
            const toggle = () => setPicked((p) => poll.multiple ? (checked ? p.filter((x) => x !== o.id) : [...p, o.id]) : [o.id]);
            return poll.multiple ? (
              <div key={o.id} className={cn("rounded-md border px-3 py-2", checked ? "border-accent bg-accent-soft/40" : "border-border")}>
                <Checkbox checked={checked} onCheckedChange={toggle} label={o.label} />
              </div>
            ) : (
              <label key={o.id} className={cn("flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-base has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus", checked ? "border-accent bg-accent-soft/40" : "border-border hover:bg-surface-hover")}>
                <input type="radio" name={groupId} value={o.id} checked={checked} onChange={toggle} className="size-4 accent-accent" />
                <span className="break-words">{o.label}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-muted">
        <span id={`${groupId}-hint`}>
          {poll.voters} {poll.voters === 1 ? "person voted" : "people voted"} · {ends}
          {poll.multiple && " · pick any"}{poll.anonymous && " · anonymous"}
        </span>
        {!poll.closed && (showResults ? (
          <Button variant="link" size="sm" onClick={() => { setChanging(true); setPicked(poll.options.filter((o) => o.mine).map((o) => o.id)); }}>Change vote</Button>
        ) : (
          <span className="flex gap-2">
            {changing && <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>Cancel</Button>}
            <Button size="sm" onClick={submit} loading={busy} disabled={!picked.length}>Vote</Button>
          </span>
        ))}
      </div>
    </div>
  );
}

function Reactions({ item, onChange }: { item: FeedItem; onChange: ItemUpdate }) {
  const mine = item.reactions.mine;
  const set = (kind: Reaction | null) => {
    const prev = item.reactions;
    // optimistic: adjust the total and my reaction straight away
    const total = prev.total + (prev.mine ? -1 : 0) + (kind ? 1 : 0);
    const top = kind && !prev.top.includes(kind) ? [kind, ...prev.top].slice(0, 3) : prev.top;
    onChange((p) => ({ ...p, reactions: { total, mine: kind, top: total ? top : [] } }));
    reactAction(item.id, kind).then((r) => {
      if (r.ok) onChange((p) => ({ ...p, reactions: r.data! }));
      else { onChange((p) => ({ ...p, reactions: prev })); toast.error(r.error); }
    });
  };
  const Meta = mine ? REACTION_META[mine] : REACTION_META.like;
  return (
    <div className="mt-3 flex flex-col">
      {(item.reactions.total > 0 || item.comments.count > 0) && (
        <div className="flex items-center justify-between px-5 pb-2 text-sm text-text-muted">
          <span className="flex items-center gap-1.5">
            {item.reactions.total > 0 && (
              <>
                <span className="flex -space-x-1" aria-hidden>
                  {item.reactions.top.map((k) => { const I = REACTION_META[k].icon; return <span key={k} className="flex size-5 items-center justify-center rounded-pill bg-accent-soft text-accent-text ring-2 ring-surface"><I className="size-3" /></span>; })}
                </span>
                <span>{item.reactions.total}<span className="sr-only"> {item.reactions.total === 1 ? "reaction" : "reactions"}</span></span>
              </>
            )}
          </span>
          {item.comments.count > 0 && <span>{item.comments.count} {item.comments.count === 1 ? "comment" : "comments"}</span>}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-border px-3 py-1.5">
        <div className="flex items-center">
          <Button variant="ghost" size="sm" aria-pressed={!!mine} onClick={() => set(mine ? null : "like")}
            className={cn("rounded-r-none", mine && "text-accent-text")}>
            <Meta.icon className={cn(mine && "fill-current")} />{mine ? Meta.label : "Like"}
          </Button>
          <Popover align="start" className="p-1.5"
            trigger={<Button variant="ghost" size="sm" className="rounded-l-none px-1.5" aria-label="Choose a reaction"><ChevronDown /></Button>}>
            <div role="group" aria-label="Reactions" className="flex gap-1">
              {(Object.keys(REACTION_META) as Reaction[]).map((k) => {
                const I = REACTION_META[k].icon;
                return (
                  <button key={k} type="button" aria-pressed={mine === k} title={REACTION_META[k].label} aria-label={REACTION_META[k].label} onClick={() => set(mine === k ? null : k)}
                    className={cn("flex size-10 items-center justify-center rounded-md text-text-muted transition-transform duration-fast hover:scale-110 hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus", mine === k && "bg-accent-soft text-accent-text")}>
                    <I className="size-5" />
                  </button>
                );
              })}
            </div>
          </Popover>
        </div>
        <Button variant="ghost" size="sm" onClick={() => document.getElementById(`comment-${item.id}`)?.focus()}><MessageCircle />Comment</Button>
      </div>
    </div>
  );
}

function Comments({ item, me, onChange, now }: { item: FeedItem; me: CardMe; onChange: ItemUpdate; now: number | null }) {
  const [all, setAll] = React.useState<CommentView[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [text, setText] = React.useState("");
  const shown = all ?? item.comments.latest;
  const hidden = item.comments.count - shown.length;

  const loadAll = async () => {
    setLoading(true);
    const r = await commentsAction(item.id);
    setLoading(false);
    if (r.ok) setAll(r.data!); else toast.error(r.error);
  };
  const apply = (list: CommentView[], count: number) => {
    if (all) setAll(list);
    onChange((p) => ({ ...p, comments: { count, latest: list.slice(-2) } }));
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    const temp: CommentView = { id: `temp-${Date.now()}`, body, createdAt: new Date().toISOString(), author: { id: me.id, name: me.name }, canDelete: false };
    const before = shown, count = item.comments.count;
    setText("");
    apply([...before, temp], count + 1);
    const r = await addCommentAction(item.id, body);
    if (r.ok) apply([...before, r.data!], count + 1);
    else { apply(before, count); setText(body); toast.error(r.error); }
  };
  const remove = async (c: CommentView) => {
    const before = shown, count = item.comments.count;
    apply(before.filter((x) => x.id !== c.id), count - 1);
    const r = await deleteCommentAction(c.id);
    if (!r.ok) { apply(before, count); toast.error(r.error); }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-sunken/50 px-5 py-3">
      {hidden > 0 && (
        <Button variant="link" size="sm" className="self-start" onClick={loadAll} loading={loading}>
          View {hidden === 1 ? "1 earlier comment" : `${hidden} earlier comments`}
        </Button>
      )}
      {loading && !all && <Skeleton className="h-10" />}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Comments">
          {shown.map((c) => (
            <li key={c.id} className={cn("group flex gap-2.5", c.id.startsWith("temp-") && "opacity-60")}>
              <Avatar name={c.author.name} size="sm" />
              <div className="min-w-0 flex-1 rounded-md bg-surface px-3 py-2 shadow-card">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <Link href={`/people/${c.author.id}`} className="font-semibold hover:underline">{c.author.name}</Link>
                  <time dateTime={c.createdAt} className="text-xs text-text-muted">{ago(c.createdAt, now)}</time>
                </p>
                <p className="whitespace-pre-line break-words text-base">{c.body}</p>
              </div>
              {c.canDelete && (
                <IconButton label="Delete comment" size="icon-sm" className="self-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" onClick={() => remove(c)}><Trash /></IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={send} className="flex items-center gap-2">
        <Avatar name={me.name} size="sm" />
        <label htmlFor={`comment-${item.id}`} className="sr-only">Write a comment</label>
        <input id={`comment-${item.id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.comment} placeholder="Write a comment"
          className="h-9 min-w-0 flex-1 rounded-pill border border-border-input bg-surface px-4 text-base placeholder:text-text-placeholder focus-visible:border-focus focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus/25" />
        <IconButton label="Post comment" type="submit" size="icon-sm" variant="soft" disabled={!text.trim()}><Send /></IconButton>
      </form>
    </div>
  );
}
