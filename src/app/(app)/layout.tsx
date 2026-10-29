import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { getActor } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AppShell, ShellSkeleton, type ShellData } from "@/ui/app-shell";
import { logoutAction } from "../(auth)/actions";
import { NotificationsBell } from "@/features/notifications-bell";
import { CommandPalette } from "@/features/command-palette";

// Entering the signed-in app may wait for the session (it can't be part of a static shell);
// moving between pages underneath keeps the shell and streams page content behind loading.tsx.
export const instant = false;

/** Who is signed in + badge counts, for the chrome only. Pages do their own (authoritative) session check. */
async function shellData(): Promise<ShellData | null> {
  "use cache: private";   // per-person, browser-side only: lets the router prefetch the chrome so navigation is instant
  cacheLife({ stale: 30 });
  const actor = await getActor();
  if (!actor) return null;
  const [counts] = await withTenant(actor.tenant.id, (tx) => tx<{ inbox: number; unread: number }[]>`
    select (select count(*)::int from approval_steps where approver_employee_id = ${actor.employeeId} and status = 'pending') as inbox,
           (select count(*)::int from notifications where user_id = ${actor.userId} and read_at is null) as unread`);
  return {
    tenant: actor.tenant.name,
    user: { name: actor.name, title: actor.title ?? "" },
    isAdmin: actor.permissions.has("*") || actor.permissions.has("employees.write"),
    inboxCount: counts.inbox, unread: counts.unread,
  };
}

/**
 * The shell renders immediately and streams the user bits in; the page underneath isn't held back by
 * the session read, so navigation between pages stays instant. (Sync component: it starts the read, doesn't await it.)
 */
function Shell({ children }: { children: React.ReactNode }) {
  const data = shellData();
  return <AppShell data={data} logout={logoutAction} bell={<NotificationsBell data={data} />} search={<CommandPalette data={data} />}>{children}</AppShell>;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
