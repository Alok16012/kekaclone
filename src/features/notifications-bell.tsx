"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, CalendarDays, CheckCheck, Inbox, UserCheck } from "lucide-react";
import { IconButton, Button } from "@/ui/button";
import { Drawer } from "@/ui/overlay";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/ui/app-shell";
import type { NotificationRow } from "@/server/modules/notifications/service";
import { listNotificationsAction, markNotificationsReadAction, unreadCountAction } from "@/app/(app)/actions";

const POLL_MS = 60_000;

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

const ICON: Record<string, React.ReactNode> = {
  "approval.pending": <Inbox />, "request.approved": <CheckCheck />, "request.rejected": <BellOff />, "leave.fyi": <CalendarDays />,
};

/**
 * Bell + drawer. The badge starts from the shell data and refreshes every minute while the tab is visible;
 * the list loads when the drawer opens. Opening an item marks it read and goes to its page.
 */
export function NotificationsBell({ data }: { data?: Promise<ShellData | null> }) {
  const initial = data ? React.use(data)?.unread ?? 0 : 0;
  const router = useRouter();
  const [unread, setUnread] = React.useState(initial);
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationRow[] | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [now, setNow] = React.useState(0);
  const [loadingMore, startMore] = React.useTransition();

  React.useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") unreadCountAction().then((r) => r.ok && setUnread(r.data!)); };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, []);

  const load = async (before?: string) => {
    const r = await listNotificationsAction(before);
    if (!r.ok) { toast.error(r.error); return; }
    setNow(Date.now());
    setItems((prev) => (before && prev ? [...prev, ...r.data!.items] : r.data!.items));
    setHasMore(r.data!.hasMore);
  };

  const openItem = async (n: NotificationRow) => {
    if (!n.read) {
      setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
      setUnread((u) => Math.max(0, u - 1));
      void markNotificationsReadAction([n.id]).then((r) => r.ok && setUnread(r.data!));
    }
    if (n.link) { setOpen(false); router.push(n.link); }
  };

  const markAll = async () => {
    setItems((xs) => xs?.map((x) => ({ ...x, read: true })) ?? null);
    setUnread(0);
    const r = await markNotificationsReadAction(null);
    if (!r.ok) toast.error(r.error);
  };

  const today = new Date(now).toDateString();
  const groups = items ? [
    { label: "Today", rows: items.filter((n) => new Date(n.created_at).toDateString() === today) },
    { label: "Earlier", rows: items.filter((n) => new Date(n.created_at).toDateString() !== today) },
  ].filter((g) => g.rows.length) : [];

  return (
    <Drawer open={open} onOpenChange={(o) => { setOpen(o); if (o) { setItems(null); void load(); } }}
      title="Notifications" description={unread ? `${unread} unread` : "You're up to date"}
      trigger={
        <IconButton label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative">
          <Bell />
          {unread > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-danger px-1 text-[10px] font-semibold tabular text-on-accent ring-2 ring-surface">{unread > 99 ? "99+" : unread}</span>}
        </IconButton>
      }
      footer={items && items.some((n) => !n.read) ? <Button variant="secondary" onClick={markAll}><CheckCheck />Mark all as read</Button> : undefined}>
      {items === null ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading notifications">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Bell />} title="No notifications yet" description="Approvals, decisions on your requests and updates from your team show up here." />
      ) : (
        <div className="-mx-5 flex flex-col">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h3 className="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">{g.label}</h3>
              <ul>
                {g.rows.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => openItem(n)}
                      className={cn("flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-surface-sunken", !n.read && "bg-accent-soft/40")}>
                      <span aria-hidden className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-pill [&_svg]:size-4", n.read ? "bg-surface-hover text-text-muted" : "bg-accent-soft text-accent-text")}>
                        {ICON[n.kind] ?? <UserCheck />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-base", !n.read && "font-semibold")}>{n.title}</span>
                        {n.body && <span className="block truncate text-sm text-text-muted">{n.body}</span>}
                        <span className="mt-0.5 block text-xs text-text-muted">{ago(n.created_at, now)}</span>
                      </span>
                      {!n.read && <span className="mt-2 size-2 shrink-0 rounded-pill bg-accent"><span className="sr-only">Unread</span></span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {hasMore && (
            <div className="px-5 py-3">
              <Button variant="ghost" block loading={loadingMore} onClick={() => startMore(() => load(items[items.length - 1]?.created_at))}>Show older</Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
