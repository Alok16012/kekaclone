import { Suspense } from "react";
import { requireActor } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AppShell, DEFAULT_NAV, ShellSkeleton } from "@/ui/app-shell";
import { logoutAction } from "../(auth)/actions";

async function Authed({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const [counts] = await withTenant(actor.tenant.id, (tx) => tx<{ inbox: number; unread: number }[]>`
    select (select count(*)::int from approval_steps where approver_employee_id = ${actor.employeeId} and status = 'pending') as inbox,
           (select count(*)::int from notifications where user_id = ${actor.userId} and read_at is null) as unread`);
  const isAdmin = actor.permissions.has("*") || actor.permissions.has("employees.write");
  const nav = DEFAULT_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => isAdmin || !["/settings", "/hire/jobs"].includes(i.href))
      .map((i) => (i.href === "/inbox" ? { ...i, badge: counts.inbox || undefined } : { ...i, badge: undefined })),
  }));
  return (
    <AppShell nav={nav} tenant={actor.tenant.name} user={{ name: actor.name, title: actor.title ?? "" }} unread={counts.unread} inboxCount={counts.inbox} logout={logoutAction}>
      {children}
    </AppShell>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <Authed>{children}</Authed>
    </Suspense>
  );
}
