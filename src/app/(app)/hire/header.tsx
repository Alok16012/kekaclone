import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canAdminHire, canRecruit } from "@/server/modules/hire/access";
import { PageHeader } from "@/ui/app-shell";
import { HireNav, type HireTabs } from "@/features/hire/shared";

/** Which hiring tabs the person gets: team members see jobs, candidates and their interviews; recruiters and admins the rest. */
export async function hireTabs(tx: Tx, actor: Actor): Promise<HireTabs & { any: boolean }> {
  const recruit = canRecruit(actor);
  const [team] = await tx`select 1 from job_team_members where employee_id = ${actor.employeeId} limit 1`;
  const [mgr] = await tx`select 1 from employees where manager_id = ${actor.employeeId} and status <> 'relieved' limit 1`;
  const onTeam = recruit || !!team;
  return { jobs: onTeam, candidates: onTeam, requisitions: recruit || !!mgr, offers: onTeam, interviews: onTeam, reports: onTeam, settings: canAdminHire(actor), any: onTeam || !!mgr };
}

export function HireHeader({ tabs, title, description, actions, breadcrumb }: { tabs: HireTabs; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} breadcrumb={breadcrumb} />
      <HireNav show={tabs} />
    </>
  );
}
