import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canFor, type Placement } from "@/server/auth/permissions";
import { board, listReasons, myExitTasks } from "@/server/modules/exits/service";
import { listTemplates } from "@/server/modules/documents/letters";
import { todayIn } from "@/lib/dates";
import { ExitsBoard } from "@/features/exits/exits-board";

export const metadata: Metadata = { title: "Exits" };

export default async function ExitsPage() {
  const d = await load(async (tx, actor) => {
    const canManage = actor.grants.some((g) => g.permissions.includes("*") || g.permissions.includes("exits.manage"));
    const myTasks = await myExitTasks(tx, actor.employeeId);
    if (!canManage) return { canManage, board: null, people: [], reasons: [], templates: [], myTasks };
    const people = await tx<({ id: string; name: string; title: string | null; department: string | null } & Placement)[]>`
      select e.id, e.display_name as name, d.title, dp.name as department, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
      from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
      where e.status <> 'relieved' and e.id <> ${actor.employeeId}
        and not exists (select 1 from exit_requests x where x.employee_id = e.id and x.status in ('under_review','in_progress'))
      order by e.display_name`;
    return {
      canManage, board: await board(tx, actor), reasons: await listReasons(tx), myTasks,
      people: people.filter((p) => canFor(actor, "exits.manage", p)).map((p) => ({ id: p.id, name: p.name, title: p.title, department: p.department })),
      templates: (await listTemplates(tx)).map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
    };
  });
  return <ExitsBoard board={d.board} people={d.people} reasons={d.reasons} letterTemplates={d.templates} myTasks={d.myTasks} today={todayIn()} canManage={d.canManage} />;
}
