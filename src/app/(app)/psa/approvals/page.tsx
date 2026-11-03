import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { approvalQueue, listProjects } from "@/server/modules/psa/service";
import { canAdminPsa, canBill } from "@/server/modules/psa/access";
import { PsaDesk } from "@/features/psa/desk";
import { TimesheetApprovals, type QueueRow } from "@/features/psa/approvals";

export const metadata: Metadata = { title: "Timesheet approvals" };
const STATUSES = ["submitted", "approved", "rejected"] as const;

export default async function TimesheetApprovalsPage(props: PageProps<"/psa/approvals">) {
  const sp = await props.searchParams;
  const status = (STATUSES as readonly string[]).includes(typeof sp.status === "string" ? sp.status : "") ? (sp.status as (typeof STATUSES)[number]) : "submitted";
  const d = await load(async (tx, actor) => {
    const [rows, projects] = await Promise.all([approvalQueue(tx, actor, status), listProjects(tx, actor)]);
    const access = { admin: canAdminPsa(actor), billing: canBill(actor), approver: projects.some((p) => p.approver) || rows.length > 0 };
    return { access, rows: rows.map((r): QueueRow => ({ id: r.id, employee: r.employee, title: r.title, week_start: r.week_start, total_minutes: r.total_minutes, billable_minutes: r.billable_minutes, status: r.status, submitted_at: r.submitted_at?.toISOString() ?? null, step_id: r.step_id, projects: r.projects })) };
  });
  return (
    <>
      <PsaDesk access={d.access} title="Timesheet approvals" description="Weeks submitted by people on the projects you approve, or who report to you." />
      <TimesheetApprovals rows={d.rows} status={status} isAdmin={d.access.admin} />
    </>
  );
}
