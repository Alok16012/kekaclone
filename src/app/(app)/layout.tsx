import { Suspense } from "react";
import { cacheLife } from "next/cache";
import { getActor } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AppShell, ShellSkeleton, type ShellData } from "@/ui/app-shell";
import { logoutAction } from "../(auth)/actions";
import { NotificationsBell } from "@/features/notifications-bell";
import { CommandPalette } from "@/features/command-palette";
import { hasAnyPayrollAdmin } from "@/server/modules/payroll/access";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { hasAnywhere } from "@/server/modules/expenses/access";
import { hasAssetsAccess } from "@/server/modules/assets/service";
import { isAgent, canAdminHelpdesk } from "@/server/modules/helpdesk/service";
import { canAdminExpenses } from "@/server/modules/expenses/access";
import { canAdminHire, canRecruit } from "@/server/modules/hire/access";
import { canAdminPsa, canBill } from "@/server/modules/psa/access";
import { hasLearnReports } from "@/server/modules/learn/service";
import { canReadReports } from "@/server/modules/reports/service";
import { isCompAdmin, isPerfAdmin } from "@/server/modules/performance/access";
import { PLAN_DEFS } from "@/server/modules/saas/plans";

// Entering the signed-in app may wait for the session (it can't be part of a static shell);
// moving between pages underneath keeps the shell and streams page content behind loading.tsx.
export const instant = false;

/** Who is signed in + badge counts, for the chrome only. Pages do their own (authoritative) session check. */
async function shellData(): Promise<ShellData | null> {
  "use cache: private";   // per-person, browser-side only: lets the router prefetch the chrome so navigation is instant
  cacheLife({ stale: 30 });
  const actor = await getActor();
  if (!actor) return null;
  const [[counts], agent] = await withTenant(actor.tenant.id, (tx) => Promise.all([tx<{ inbox: number; unread: number }[]>`
    select (select count(*)::int from approval_steps where approver_employee_id = ${actor.employeeId} and status = 'pending') as inbox,
           (select count(*)::int from notifications where user_id = ${actor.userId} and read_at is null) as unread`, isAgent(tx, actor)]));
  // Admin-only nav/palette entries a person sees without being a general admin (pages still check access themselves).
  const areas: string[] = [];
  if (hasAnyPayrollAdmin(actor)) areas.push("payroll", "settings");
  if (canRunPayroll(actor)) areas.push("payrun");
  if (canAdminExpenses(actor)) areas.push("expenses-settings", "settings");
  if (["expenses.approve", "expenses.payout", "expenses.admin"].some((p) => hasAnywhere(actor, p))) areas.push("expenses");
  if (hasAssetsAccess(actor)) areas.push("assets");
  if (agent) areas.push("helpdesk");
  if (canAdminHelpdesk(actor)) areas.push("helpdesk-settings", "settings");
  if (canRecruit(actor) || canAdminHire(actor)) areas.push("hire");
  if (canAdminHire(actor)) areas.push("hire-settings", "settings");
  if (canAdminPsa(actor) || canBill(actor)) areas.push("psa");
  if (hasLearnReports(actor)) areas.push("learn");
  if (canReadReports(actor)) areas.push("reports");
  if (isPerfAdmin(actor)) areas.push("performance", "settings");
  if (isCompAdmin(actor)) areas.push("compensation");
  if (hasAnywhere(actor, "onboarding.manage")) areas.push("onboarding");
  if (hasAnywhere(actor, "surveys.manage")) areas.push("surveys");
  return {
    tenant: actor.tenant.name,
    user: { name: actor.name, title: actor.title ?? "" },
    isAdmin: actor.permissions.has("*") || actor.permissions.has("employees.write"),
    areas: [...new Set(areas)],
    features: PLAN_DEFS[actor.tenant.plan ?? "core"].features,
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
