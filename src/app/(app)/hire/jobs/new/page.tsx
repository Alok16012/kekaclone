import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { canRecruit } from "@/server/modules/hire/access";
import { jobFormData } from "@/server/modules/hire/jobs";
import { assistantState } from "@/server/modules/hire/assist";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { JobWizard, type WizardJob } from "@/features/hire/job-wizard";
import { HireHeader, hireTabs } from "../../header";

export const metadata: Metadata = { title: "Create job" };

export default async function NewJobPage(props: PageProps<"/hire/jobs/new">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    if (!canRecruit(actor)) return { tabs, data: null, job: null, assistant: undefined };
    const [data, assistant] = await Promise.all([jobFormData(tx), assistantState(tx)]);
    const flow = data.flows.find((f) => f.is_default) ?? data.flows[0];
    if (!flow) throw new AppError("invalid", "Set up a hiring flow first.");
    const job: WizardJob = {
      id: null, title: "", department_id: null, location_id: null, description_html: "", openings: 1, target_date: null, job_type: "full_time", experience_min: null, experience_max: null,
      salary_min_paise: null, salary_max_paise: null, show_salary: false, hiring_flow_id: flow.id, allow_reapply_after_days: 90, publish: { career_site: true, internal: true, referrals: true },
      requisition_id: null, team: [{ employee_id: actor.employeeId, role: "recruiter" }], status: "draft", applications: 0,
    };
    // from an approved requisition: copy its details in
    const reqId = typeof sp.requisition === "string" && /^[0-9a-f-]{36}$/i.test(sp.requisition) ? sp.requisition : null;
    if (reqId) {
      const [r] = await tx<{ id: string; title: string; department_id: string | null; location_id: string | null; openings: number; target_date: string | null; job_type: string; experience_min: number | null; experience_max: number | null; salary_min_paise: bigint | null; salary_max_paise: bigint | null; description: string | null; raised_by_employee_id: string }[]>`
        select id, title, department_id, location_id, openings, target_date::text, job_type, experience_min, experience_max, salary_min_paise, salary_max_paise, description, raised_by_employee_id from requisitions where id = ${reqId} and status = 'approved'`;
      if (r) Object.assign(job, {
        title: r.title, department_id: r.department_id, location_id: r.location_id, openings: r.openings, target_date: r.target_date, job_type: r.job_type, experience_min: r.experience_min, experience_max: r.experience_max,
        salary_min_paise: r.salary_min_paise == null ? null : Number(r.salary_min_paise), salary_max_paise: r.salary_max_paise == null ? null : Number(r.salary_max_paise),
        description_html: r.description ? `<p>${r.description.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "", requisition_id: r.id,
        team: [{ employee_id: actor.employeeId, role: "recruiter" }, ...(r.raised_by_employee_id !== actor.employeeId ? [{ employee_id: r.raised_by_employee_id, role: "hiring_manager" }] : [])],
      });
    }
    return { tabs, data, job, assistant };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="Create job" description="Four short steps: the posting, details, the hiring team, and where to publish." />
      {!d.data || !d.job ? <Card><EmptyState title="Only recruiters can create jobs" description="Ask a hiring admin to give you the Recruiter role, or raise a requisition instead." /></Card> : <JobWizard data={d.data} job={d.job} assistant={d.assistant} />}
    </>
  );
}
