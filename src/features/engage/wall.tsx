"use client";
import * as React from "react";
import { Building, ChartBar, Megaphone, MessagesSquare, PenLine, RefreshCw, Sparkles } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { TabsList, Tabs } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import type { Person } from "@/ui/employee-picker";
import type { PostKind } from "@/server/modules/engage/rules";
import type { ComposerOptions, FeedItem, FeedPage, FeedTab } from "@/server/modules/engage/service";
import { feedPageAction } from "@/app/(app)/engage/actions";
import { Composer } from "./composer";
import { PostCard, type CardMe } from "./post-card";
import { fmtDateTime } from "./use-now";

type TabState = { pinned: FeedItem[]; items: FeedItem[]; cursor: string | null; noDepartment?: boolean };

export function FeedSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading posts">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="p-5">
          <div className="flex items-center gap-3"><Skeleton className="size-10 rounded-pill" /><div className="flex-1"><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-3 w-24" /></div></div>
          <Skeleton className="mt-4 h-4 w-full" /><Skeleton className="mt-2 h-4 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

/**
 * The Home wall: Organisation / My department tabs, a composer, and a cursor-paged feed.
 * The first page of the Organisation tab comes from the server; everything after that is loaded and updated here.
 */
export function Wall({ initial, options, people, me, defaultCompose }: {
  initial: FeedPage; options: ComposerOptions; people: Person[]; me: CardMe; defaultCompose?: PostKind | null;
}) {
  const [tab, setTab] = React.useState<FeedTab>("org");
  const [tabs, setTabs] = React.useState<Record<FeedTab, TabState | null>>({ org: { pinned: initial.pinned, items: initial.items, cursor: initial.nextCursor }, department: null });
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [composer, setComposer] = React.useState<PostKind | null>(defaultCompose ?? null);
  const current = tabs[tab];

  const load = React.useCallback(async (t: FeedTab, cursor: string | null) => {
    setLoading(true); setError(null);
    const r = await feedPageAction(t, cursor);
    setLoading(false);
    if (!r.ok) { setError(r.error); return; }
    const p = r.data!;
    setTabs((s) => {
      const prev = cursor ? s[t] : null;
      const seen = new Set([...(prev?.pinned ?? []), ...(prev?.items ?? [])].map((x) => x.id));
      return { ...s, [t]: { pinned: prev?.pinned ?? p.pinned, items: [...(prev?.items ?? []), ...p.items.filter((x) => !seen.has(x.id))], cursor: p.nextCursor, noDepartment: p.noDepartment } };
    });
  }, []);

  const switchTab = (t: string) => {
    const next = t as FeedTab;
    setTab(next);
    setError(null);
    if (!tabs[next]) void load(next, null);
  };

  const update = (id: string) => (fn: (prev: FeedItem) => FeedItem) => setTabs((s) => {
    const map = (xs: FeedItem[]) => xs.map((x) => (x.id === id ? fn(x) : x));
    return { org: s.org && { ...s.org, pinned: map(s.org.pinned), items: map(s.org.items) }, department: s.department && { ...s.department, pinned: map(s.department.pinned), items: map(s.department.items) } };
  });
  const remove = (id: string) => setTabs((s) => {
    const drop = (xs: FeedItem[]) => xs.filter((x) => x.id !== id);
    return { org: s.org && { ...s.org, pinned: drop(s.org.pinned), items: drop(s.org.items) }, department: s.department && { ...s.department, pinned: drop(s.department.pinned), items: drop(s.department.items) } };
  });
  const created = (item: FeedItem | null, scheduledFor: string | null) => {
    if (!item) { toast.success(`Scheduled for ${fmtDateTime(scheduledFor!)}`, { description: "It'll appear on the wall and notify people then." }); return; }
    const toDept = item.audience.type === "departments" && item.kind !== "announcement";
    setTabs((s) => {
      const add = (st: TabState | null) => st && (item.pinned ? { ...st, pinned: [item, ...st.pinned] } : { ...st, items: [item, ...st.items] });
      return toDept ? { ...s, department: add(s.department) } : { ...s, org: add(s.org), department: item.audience.type === "departments" ? add(s.department) : s.department };
    });
    if (toDept && tab !== "department") { setTab("department"); if (!tabs.department) void load("department", null); }
    toast.success({ post: "Posted", poll: "Poll started", praise: "Praise sent", announcement: "Announcement published" }[item.kind]);
  };

  const quick: { kind: PostKind; label: string; icon: React.ReactNode }[] = [
    { kind: "post", label: "Post", icon: <PenLine /> },
    { kind: "poll", label: "Poll", icon: <ChartBar /> },
    { kind: "praise", label: "Praise", icon: <Sparkles /> },
    ...(options.announce ? [{ kind: "announcement" as const, label: "Announce", icon: <Megaphone /> }] : []),
  ];
  const all = current ? [...current.pinned, ...current.items] : [];
  const deptName = options.myDepartment?.name ?? "My department";

  return (
    <section aria-labelledby="wall-heading" className="flex min-w-0 flex-col gap-4">
      <h2 id="wall-heading" className="sr-only">Home wall</h2>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <Avatar name={me.name} />
          <button type="button" onClick={() => setComposer("post")}
            className="h-10 flex-1 truncate rounded-pill border border-border-input bg-surface-sunken px-4 text-left text-base text-text-placeholder transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus">
            Share an update with your colleagues…
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {quick.map((q) => <Button key={q.kind} variant="ghost" size="sm" onClick={() => setComposer(q.kind)}>{q.icon}{q.label}</Button>)}
        </div>
      </Card>

      <Tabs value={tab} onValueChange={switchTab}>
        <TabsList className="overflow-y-hidden" items={[{ value: "org", label: "Organisation" }, { value: "department", label: options.myDepartment ? `My department · ${deptName}` : "My department" }]} />
      </Tabs>

      {error && (
        <Banner tone="danger" title="Couldn't load the wall" action={<Button size="sm" variant="secondary" onClick={() => load(tab, current?.cursor ?? null)}><RefreshCw />Try again</Button>}>
          {error}
        </Banner>
      )}

      {!current ? (
        !error && <FeedSkeleton />
      ) : current.noDepartment ? (
        <Card><EmptyState icon={<Building />} title="You're not in a department yet" description="Once HR adds you to a department, posts for your team show up here." /></Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState icon={<MessagesSquare />}
            title={tab === "org" ? "Nothing on the wall yet" : `No posts for ${deptName} yet`}
            description={tab === "org" ? "Start the conversation: share an update, ask a question or thank a colleague." : "Posts you share with your department show up here."}
            action={<Button onClick={() => setComposer("post")}><PenLine />Write the first post</Button>} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {all.map((item) => <PostCard key={item.id} item={item} me={me} onChange={update(item.id)} onDeleted={remove} />)}
          {current.cursor ? (
            <Button variant="secondary" className="self-center" loading={loading} onClick={() => load(tab, current.cursor)}>Show older posts</Button>
          ) : (
            all.length > 3 && <p className="py-2 text-center text-sm text-text-muted">You&apos;re all caught up.</p>
          )}
        </div>
      )}

      {composer && (
        <Composer open onOpenChange={(o) => { if (!o) setComposer(null); }} initialKind={composer} options={options}
          people={people.filter((p) => p.id !== me.id)} onCreated={created} />
      )}
    </section>
  );
}
