import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { UserMinus } from "lucide-react";
import { load } from "@/server/page-data";
import { getProfile, lookups } from "@/server/modules/employees/profile";
import { canFor, type Placement } from "@/server/auth/permissions";
import { listReasons, myExit } from "@/server/modules/exits/service";
import { personDocuments } from "@/server/modules/documents/service";
import { listTemplates } from "@/server/modules/documents/letters";
import { todayIn } from "@/lib/dates";
import { ProfileView } from "@/features/profile/profile-view";
import { Button } from "@/ui/button";
import { ExitStatusBanner, MyExitBanner, ResignDialog } from "@/features/exits/resign";
import { InitiateExit } from "@/features/exits/initiate-exit";
import { PersonDocuments } from "@/features/documents/person-documents";
import { praiseFor } from "@/server/modules/engage/service";
import { PraiseReceivedCard } from "@/features/engage/home-widgets";
import { financesFor } from "@/server/modules/payroll/salary";
import { FinancesTab } from "@/features/payroll/finances-tab";
import { personAssets } from "@/server/modules/assets/service";
import { PersonAssets } from "@/features/assets/person-assets";
import { toPersonAssetsDTO } from "@/features/assets/dto";
import { assignedPolicies, timeTab } from "@/server/modules/corehr/people";
import { profileSections } from "@/server/modules/corehr/profile-sections";
import { personFields } from "@/server/modules/corehr/custom-fields";
import { ProfileExtras } from "@/features/corehr/profile-extras";
import { AssignedPolicies, IdCardLink, RehireDialog, TimeTab } from "@/features/corehr/person-tabs";

export const metadata: Metadata = { title: "Profile" };

export default async function PersonPage(props: PageProps<"/people/[id]">) {
  const { id } = await props.params;
  const { tab } = await props.searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const p = await getProfile(tx, actor, id);
    if (!p) return null;
    const [m] = await tx<(Placement & { manager_id: string | null })[]>`select manager_id, department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${id}`;
    const self = actor.employeeId === id;
    const manageExit = !self && canFor(actor, "exits.manage", m);
    const [docs, praise, finances, assets] = await Promise.all([personDocuments(tx, actor, id), praiseFor(tx, actor, id), financesFor(tx, actor, id), personAssets(tx, actor, id)]);
    const issue = !!docs?.canManage && canFor(actor, "documents.manage", m);
    const [sections, fields, policies, time] = await Promise.all([profileSections(tx, actor, id), personFields(tx, actor, id), assignedPolicies(tx, actor, id), timeTab(tx, actor, id)]);
    const canRehire = p.employee.status === "relieved" && canFor(actor, "employees.write", m);
    const [x] = canRehire ? await tx<{ ok: boolean | null }[]>`select ok_to_rehire as ok from exit_requests where employee_id = ${id} and status = 'exited' order by updated_at desc limit 1` : [];
    return {
      p, lookups: p.access === "admin" ? await lookups(tx) : null, managerId: m.manager_id, self, manageExit,
      exit: self || manageExit ? await myExit(tx, id) : null,
      reasons: (self || manageExit) && p.employee.status !== "relieved" ? await listReasons(tx) : [],
      praise, docs, finances, assets: assets ? toPersonAssetsDTO(assets) : null, sections, fields, policies, time,
      rehire: canRehire ? { notRehirable: x?.ok === false, lookups: await lookups(tx) } : null, templates: issue ? (await listTemplates(tx)).map((t) => ({ id: t.id, name: t.name, kind: t.kind })) : [],
    };
  });
  if (!d) notFound();
  const today = todayIn();
  const e = d.p.employee;
  const open = d.exit && (d.exit.status === "under_review" || d.exit.status === "in_progress");
  const idCard = e.status !== "relieved" && d.p.access !== "colleague" ? <IdCardLink employeeId={e.id} /> : null;
  const actions = d.rehire ? <RehireDialog employeeId={e.id} name={e.display_name} today={today} lookups={d.rehire.lookups} notRehirable={d.rehire.notRehirable} />
    : e.status === "relieved" || open ? idCard ?? undefined
    : d.self ? <>{idCard}<ResignDialog reasons={d.reasons} today={today} /></>
    : d.manageExit ? <>{idCard}<InitiateExit people={[{ id: e.id, name: e.display_name, title: e.designation, department: e.department }]} defaultEmployeeId={e.id} reasons={d.reasons} today={today} trigger={<Button variant="secondary" size="sm"><UserMinus />Initiate exit</Button>} /></>
    : idCard ?? undefined;
  const banner = !d.exit ? undefined : d.self ? <MyExitBanner exit={d.exit} /> : <ExitStatusBanner exit={d.exit} name={e.first_name} />;
  const tabs = d.docs ? [{
    value: "documents", label: "Documents",
    content: <PersonDocuments employeeId={e.id} name={e.display_name} canManage={d.docs.canManage} isSelf={d.docs.isSelf} templates={d.templates}
      docs={d.docs.docs.map((x) => ({ id: x.id, category: x.category, doc_type: x.doc_type, number: x.number, status: x.status, file_id: x.file_id, file_name: x.file_name, size_bytes: x.size_bytes, created_at: x.created_at.toISOString() }))} />,
  }] : [];
  if (d.time) tabs.push({ value: "time", label: "Time", content: <TimeTab employeeId={e.id} initial={d.time} thisMonth={today.slice(0, 8) + "01"} /> });
  if (d.assets) tabs.push({ value: "assets", label: "Assets", content: <PersonAssets data={d.assets} name={e.display_name} /> });
  if (d.finances) tabs.push({ value: "finances", label: "Finances", content: <FinancesTab employeeId={e.id} d={d.finances} /> });
  return <ProfileView initialTab={typeof tab === "string" ? tab : undefined} p={d.p} lookups={d.lookups} today={today} currentManagerId={d.managerId} actions={actions} banner={banner} extraTabs={tabs}
    aboutExtra={<PraiseReceivedCard items={d.praise} self={d.p.access === "self"} />}
    profileExtra={d.sections ? <ProfileExtras employeeId={e.id} s={d.sections} fields={d.fields} self={d.self} /> : undefined}
    jobExtra={d.policies ? <AssignedPolicies p={d.policies} /> : undefined} />;
}
