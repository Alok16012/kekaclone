import "server-only";
import type { Tx } from "@/server/db";
import type { ColType } from "./rules";

export type Header = { key: string; label: string; type: ColType };
export type ReportResult = { headers: Header[]; rows: Record<string, unknown>[]; note?: string };
export type FilterDef = { key: string; label: string; type: "date_range" | "select" | "month"; options?: { value: string; label: string }[]; optionsFrom?: "departments" | "locations" | "courses" | "projects" | "people" };
export type Params = { from: string; to: string; [k: string]: string };
export type Ctx = { ids: string[]; params: Params; today: string };

export type StandardReport = {
  key: string; name: string; description: string; group: "People" | "Time" | "Money" | "Service desk" | "Projects" | "Learning";
  filters: FilterDef[];
  run: (tx: Tx, ctx: Ctx) => Promise<ReportResult>;
};

const dept: FilterDef = { key: "department", label: "Department", type: "select", optionsFrom: "departments" };
const loc: FilterDef = { key: "location", label: "Location", type: "select", optionsFrom: "locations" };
const range: FilterDef = { key: "range", label: "Period", type: "date_range" };
const H = (key: string, label: string, type: ColType = "text"): Header => ({ key, label, type });
const uuid = (s: string | undefined) => (s && /^[0-9a-f-]{36}$/i.test(s) ? s : null);

export const STANDARD_REPORTS: StandardReport[] = [
  {
    key: "employee_master", name: "Employee master", description: "Everyone with their job, reporting and contact details.", group: "People",
    filters: [dept, loc, { key: "status", label: "Status", type: "select", options: [{ value: "active", label: "Active and on notice" }, { value: "all", label: "Including left" }] }],
    run: async (tx, { ids, params }) => ({
      headers: [H("number", "Employee number"), H("name", "Name"), H("email", "Work email"), H("department", "Department"), H("designation", "Designation"), H("location", "Location"), H("legal_entity", "Legal entity"),
        H("manager", "Manager"), H("joining_date", "Joining date", "date"), H("worker_type", "Worker type"), H("status", "Status"), H("gender", "Gender"), H("mobile", "Mobile"), H("exit_date", "Exit date", "date")],
      rows: await tx`select e.employee_number as number, e.display_name as name, e.work_email::text as email, d.name as department, g.title as designation, l.name as location, le.name as legal_entity, m.display_name as manager,
          e.joining_date::text, e.worker_type, e.status, e.gender, e.mobile, e.exit_date::text
        from employees e left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id left join locations l on l.id = e.location_id
        left join legal_entities le on le.id = e.legal_entity_id left join employees m on m.id = e.manager_id
        where e.id = any(${ids}::uuid[]) and (${params.status === "all"} or e.status <> 'relieved')
          and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid) and (${uuid(params.location)}::uuid is null or e.location_id = ${uuid(params.location)}::uuid)
        order by e.display_name`,
    }),
  },
  {
    key: "headcount", name: "Headcount", description: "People by department and location, with joiners and leavers in the period.", group: "People", filters: [range],
    run: async (tx, { ids, params }) => ({
      headers: [H("department", "Department"), H("location", "Location"), H("headcount", "Headcount", "number"), H("joined", "Joined in period", "number"), H("left", "Left in period", "number"), H("on_notice", "On notice", "number")],
      rows: await tx`select coalesce(d.name, 'No department') as department, coalesce(l.name, 'No location') as location,
          count(*) filter (where e.status <> 'relieved')::int as headcount,
          count(*) filter (where e.joining_date between ${params.from} and ${params.to})::int as joined,
          count(*) filter (where e.exit_date between ${params.from} and ${params.to} and e.status = 'relieved')::int as "left",
          count(*) filter (where e.status = 'notice')::int as on_notice
        from employees e left join departments d on d.id = e.department_id left join locations l on l.id = e.location_id
        where e.id = any(${ids}::uuid[]) group by 1, 2 order by 1, 2`,
    }),
  },
  {
    key: "attrition", name: "Attrition", description: "Exits by month with the attrition rate against headcount at the start of each month.", group: "People", filters: [range],
    run: async (tx, { ids, params }) => ({
      headers: [H("month", "Month"), H("headcount_start", "Headcount at start", "number"), H("exits", "Exits", "number"), H("resignations", "Resignations", "number"), H("rate", "Attrition %", "number"), H("reasons", "Top reasons")],
      rows: await tx`with months as (select generate_series(date_trunc('month', ${params.from}::date), date_trunc('month', ${params.to}::date), interval '1 month')::date as m)
        select to_char(m, 'Mon YYYY') as month,
          (select count(*)::int from employees e where e.id = any(${ids}::uuid[]) and e.joining_date < m and (e.exit_date is null or e.exit_date >= m)) as headcount_start,
          (select count(*)::int from employees e where e.id = any(${ids}::uuid[]) and e.status = 'relieved' and e.exit_date >= m and e.exit_date < m + interval '1 month') as exits,
          (select count(*)::int from exit_requests x join employees e on e.id = x.employee_id where e.id = any(${ids}::uuid[]) and x.kind = 'resignation' and x.status = 'exited' and x.last_working_date >= m and x.last_working_date < m + interval '1 month') as resignations,
          (select case when count(*) filter (where e.joining_date < m and (e.exit_date is null or e.exit_date >= m)) = 0 then 0 else
              round(100.0 * count(*) filter (where e.status = 'relieved' and e.exit_date >= m and e.exit_date < m + interval '1 month') / count(*) filter (where e.joining_date < m and (e.exit_date is null or e.exit_date >= m)), 1) end::float
            from employees e where e.id = any(${ids}::uuid[])) as rate,
          (select string_agg(r.name || ' (' || n || ')', ', ' order by n desc) from (select er.name, count(*) as n from exit_requests x join exit_reasons er on er.id = x.reason_id join employees e on e.id = x.employee_id
              where e.id = any(${ids}::uuid[]) and x.status = 'exited' and x.last_working_date >= m and x.last_working_date < m + interval '1 month' group by er.name limit 3) r) as reasons
        from months order by m`,
    }),
  },
  {
    key: "login_history", name: "Sign-in history", description: "Every sign-in attempt: who, when, how, from where, and whether it worked. Pick a person for their own history.", group: "People",
    filters: [range, { key: "person", label: "Person", type: "select", optionsFrom: "people" }, { key: "result", label: "Result", type: "select", options: [{ value: "all", label: "All attempts" }, { value: "success", label: "Successful" }, { value: "failure", label: "Failed" }] }],
    run: async (tx, { ids, params }) => ({
      headers: [H("at", "When (IST)"), H("name", "Name"), H("email", "Email"), H("method", "Method"), H("success", "Signed in", "bool"), H("ip", "IP address"), H("user_agent", "Browser")],
      // attempts against unknown addresses (no account) only show to readers who can see the whole company
      rows: await tx`select to_char(l.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as at, e.display_name as name, coalesce(l.email::text, u.email::text) as email, l.method, l.success, host(l.ip) as ip, l.user_agent
        from login_events l left join users u on u.id = l.user_id left join employees e on e.user_id = u.id
        where (l.created_at at time zone 'Asia/Kolkata')::date between ${params.from} and ${params.to}
          and (e.id = any(${ids}::uuid[]) or (e.id is null and ${uuid(params.person)}::uuid is null and (select count(*) from employees) = ${ids.length}))
          and (${uuid(params.person)}::uuid is null or e.id = ${uuid(params.person)}::uuid)
          and (${params.result === "success" ? true : null}::boolean is null or l.success) and (${params.result === "failure" ? true : null}::boolean is null or not l.success)
        order by l.created_at desc limit 5000`,
      note: "Up to 5,000 most recent attempts. Narrow the period or pick a person for more.",
    }),
  },
  {
    key: "leave_balances", name: "Leave balances", description: "Current cycle balance per person and leave type.", group: "Time", filters: [dept],
    run: async (tx, { ids, params }) => ({
      headers: [H("number", "Employee number"), H("name", "Name"), H("department", "Department"), H("type", "Leave type"), H("cycle_start", "Cycle from", "date"), H("credited", "Credited", "number"), H("used", "Used", "number"), H("pending", "Pending requests", "number"), H("available", "Available", "number")],
      rows: await tx`select e.employee_number as number, e.display_name as name, d.name as department, t.name as type, b.cycle_start::text,
          coalesce(b.credited, 0)::float as credited, coalesce(b.used, 0)::float as used,
          coalesce((select sum(r.days) from leave_requests r where r.employee_id = e.id and r.leave_type_id = t.id and r.status = 'pending'), 0)::float as pending,
          (coalesce(b.balance, 0) - coalesce((select sum(r.days) from leave_requests r where r.employee_id = e.id and r.leave_type_id = t.id and r.status = 'pending'), 0))::float as available
        from (select distinct on (employee_id, leave_type_id) * from leave_balances order by employee_id, leave_type_id, cycle_start desc) b
        join employees e on e.id = b.employee_id join leave_types t on t.id = b.leave_type_id left join departments d on d.id = e.department_id
        where e.id = any(${ids}::uuid[]) and e.status <> 'relieved' and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid)
        order by e.display_name, t.name`,
    }),
  },
  {
    key: "leave_usage", name: "Leave taken", description: "Leave requests in the period with type, days and status.", group: "Time",
    filters: [range, dept, { key: "status", label: "Status", type: "select", options: [{ value: "approved", label: "Approved only" }, { value: "all", label: "All statuses" }] }],
    run: async (tx, { ids, params }) => ({
      headers: [H("number", "Employee number"), H("name", "Name"), H("department", "Department"), H("type", "Leave type"), H("from_date", "From", "date"), H("to_date", "To", "date"), H("days", "Days", "number"), H("status", "Status"), H("note", "Note")],
      rows: await tx`select e.employee_number as number, e.display_name as name, d.name as department, t.name as type, r.from_date::text, r.to_date::text, r.days::float as days, r.status, r.note
        from leave_requests r join employees e on e.id = r.employee_id join leave_types t on t.id = r.leave_type_id left join departments d on d.id = e.department_id
        where e.id = any(${ids}::uuid[]) and r.from_date <= ${params.to} and r.to_date >= ${params.from} and (${params.status === "all"} or r.status = 'approved')
          and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid)
        order by r.from_date desc, e.display_name`,
    }),
  },
  {
    key: "attendance_summary", name: "Attendance summary", description: "Per person: days present, absent, on leave, late, and average hours in the period.", group: "Time", filters: [range, dept],
    run: async (tx, { ids, params }) => ({
      headers: [H("number", "Employee number"), H("name", "Name"), H("department", "Department"), H("working_days", "Working days", "number"), H("present", "Present", "number"), H("absent", "Absent", "number"), H("leave", "On leave", "number"),
        H("wfh", "WFH / on duty", "number"), H("late_days", "Late days", "number"), H("avg_hours", "Avg effective hours", "number"), H("overtime_hours", "Overtime hours", "number")],
      rows: await tx`select e.employee_number as number, e.display_name as name, d.name as department,
          count(*) filter (where a.day_type = 'working')::int as working_days,
          count(*) filter (where a.status in ('present','half_day'))::int as present, count(*) filter (where a.status = 'absent')::int as absent,
          count(*) filter (where a.status in ('leave','half_leave'))::int as leave, count(*) filter (where a.status in ('wfh','on_duty'))::int as wfh,
          count(*) filter (where a.late_minutes > 0)::int as late_days,
          coalesce(round(avg(a.effective_minutes) filter (where a.status in ('present','half_day','wfh','on_duty')) / 60.0, 2), 0)::float as avg_hours,
          round(coalesce(sum(a.overtime_minutes), 0) / 60.0, 2)::float as overtime_hours
        from employees e left join departments d on d.id = e.department_id join attendance_days a on a.employee_id = e.id and a.date between ${params.from} and ${params.to}
        where e.id = any(${ids}::uuid[]) and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid)
        group by e.id, e.employee_number, e.display_name, d.name order by e.display_name`,
    }),
  },
  {
    key: "attendance_late", name: "Late arrivals", description: "Every day someone clocked in after their shift started.", group: "Time", filters: [range, dept],
    run: async (tx, { ids, params }) => ({
      headers: [H("date", "Date", "date"), H("number", "Employee number"), H("name", "Name"), H("department", "Department"), H("shift", "Shift"), H("first_in", "Clocked in"), H("late_minutes", "Late by (min)", "number"), H("status", "Day status")],
      rows: await tx`select a.date::text, e.employee_number as number, e.display_name as name, d.name as department, s.name as shift, to_char(a.first_in at time zone 'Asia/Kolkata', 'HH24:MI') as first_in, a.late_minutes, a.status
        from attendance_days a join employees e on e.id = a.employee_id left join departments d on d.id = e.department_id left join shifts s on s.id = a.shift_id
        where e.id = any(${ids}::uuid[]) and a.date between ${params.from} and ${params.to} and a.late_minutes > 0 and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid)
        order by a.date desc, a.late_minutes desc`,
    }),
  },
  {
    key: "expenses", name: "Expense claims", description: "Claims submitted in the period with totals and status.", group: "Money", filters: [range, dept],
    run: async (tx, { ids, params }) => ({
      headers: [H("claim", "Claim", "number"), H("submitted_on", "Submitted", "date"), H("name", "Name"), H("department", "Department"), H("title", "Title"), H("total", "Total (INR)", "money"), H("status", "Status"), H("payout", "Payout"), H("payout_month", "Payout month")],
      rows: await tx`select c.number as claim, (c.submitted_at at time zone 'Asia/Kolkata')::date::text as submitted_on, e.display_name as name, d.name as department, c.title, c.total_paise as total, c.status, c.payout, to_char(c.payout_month, 'Mon YYYY') as payout_month
        from expense_claims c join employees e on e.id = c.employee_id left join departments d on d.id = e.department_id
        where e.id = any(${ids}::uuid[]) and c.status <> 'draft' and (c.submitted_at at time zone 'Asia/Kolkata')::date between ${params.from} and ${params.to}
          and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid)
        order by c.submitted_at desc`,
    }),
  },
  {
    key: "helpdesk_sla", name: "Helpdesk SLA", description: "Tickets raised in the period and whether response and resolution targets were met.", group: "Service desk", filters: [range],
    run: async (tx, { ids, params }) => ({
      headers: [H("ticket", "Ticket", "number"), H("raised_on", "Raised", "date"), H("title", "Title"), H("category", "Category"), H("raised_by", "Raised by"), H("assignee", "Assignee"), H("priority", "Priority"), H("status", "Status"),
        H("first_response_met", "First response in time", "bool"), H("resolution_met", "Resolved in time", "bool"), H("hours_to_close", "Hours to close", "number")],
      rows: await tx`select t.number as ticket, (t.created_at at time zone 'Asia/Kolkata')::date::text as raised_on, t.title, k.name as category, e.display_name as raised_by, a.display_name as assignee, t.priority, t.status,
          (t.first_response_due_at is null or (t.first_responded_at is not null and t.first_responded_at <= t.first_response_due_at)) as first_response_met,
          case when t.closed_at is null then null else (t.resolution_due_at is null or t.closed_at <= t.resolution_due_at) end as resolution_met,
          round(extract(epoch from (t.closed_at - t.created_at)) / 3600)::float as hours_to_close
        from tickets t join employees e on e.id = t.raised_by_employee_id join ticket_categories k on k.id = t.category_id left join employees a on a.id = t.assignee_employee_id
        where e.id = any(${ids}::uuid[]) and (t.created_at at time zone 'Asia/Kolkata')::date between ${params.from} and ${params.to} order by t.created_at desc`,
    }),
  },
  {
    key: "timesheets", name: "Timesheet hours", description: "Hours logged per person and project in the period, split by billable and approval status.", group: "Projects", filters: [range, { key: "project", label: "Project", type: "select", optionsFrom: "projects" }],
    run: async (tx, { ids, params }) => ({
      headers: [H("name", "Name"), H("department", "Department"), H("client", "Client"), H("project", "Project"), H("code", "Code"), H("hours", "Hours", "number"), H("billable_hours", "Billable hours", "number"), H("approved_hours", "Approved hours", "number"), H("invoiced_hours", "Invoiced hours", "number")],
      rows: await tx`select e.display_name as name, d.name as department, c.name as client, p.name as project, p.code,
          round(sum(x.minutes) / 60.0, 2)::float as hours, round(sum(x.minutes) filter (where x.is_billable) / 60.0, 2)::float as billable_hours,
          round(coalesce(sum(x.minutes) filter (where ts.status = 'approved'), 0) / 60.0, 2)::float as approved_hours, round(coalesce(sum(x.minutes) filter (where x.invoice_id is not null), 0) / 60.0, 2)::float as invoiced_hours
        from time_entries x join timesheets ts on ts.id = x.timesheet_id join employees e on e.id = ts.employee_id join projects p on p.id = x.project_id left join clients c on c.id = p.client_id left join departments d on d.id = e.department_id
        where e.id = any(${ids}::uuid[]) and x.date between ${params.from} and ${params.to} and (${uuid(params.project)}::uuid is null or p.id = ${uuid(params.project)}::uuid)
        group by e.display_name, d.name, c.name, p.name, p.code order by e.display_name, p.name`,
    }),
  },
  {
    key: "learning", name: "Learning progress", description: "Course enrolments with progress, due dates and completion.", group: "Learning", filters: [dept, { key: "course", label: "Course", type: "select", optionsFrom: "courses" }],
    run: async (tx, { ids, params, today }) => ({
      headers: [H("name", "Name"), H("department", "Department"), H("course", "Course"), H("state", "State"), H("percent", "Progress %", "number"), H("due_date", "Due", "date"), H("completed_on", "Completed on", "date"), H("best_score", "Best quiz score %", "number")],
      rows: await tx`select e.display_name as name, d.name as department, c.title as course,
          case when n.completed_at is not null then 'Completed' when n.due_date < ${today} then 'Overdue' when n.percent > 0 then 'In progress' else 'Not started' end as state,
          n.percent::float as percent, n.due_date::text, (n.completed_at at time zone 'Asia/Kolkata')::date::text as completed_on,
          (select max(round(q.score::numeric * 100 / nullif(q.total, 0)))::int from quiz_attempts q where q.enrollment_id = n.id) as best_score
        from enrollments n join employees e on e.id = n.employee_id join courses c on c.id = n.course_id left join departments d on d.id = e.department_id
        where e.id = any(${ids}::uuid[]) and c.status <> 'draft' and (${uuid(params.department)}::uuid is null or e.department_id = ${uuid(params.department)}::uuid) and (${uuid(params.course)}::uuid is null or c.id = ${uuid(params.course)}::uuid)
        order by c.title, e.display_name`,
    }),
  },
  {
    key: "payroll_runs", name: "Payroll register", description: "Payroll runs by month. Open a run in Payroll to download its register.", group: "Money", filters: [],
    run: async (tx) => ({
      headers: [H("month", "Month"), H("pay_group", "Pay group"), H("status", "Status"), H("people", "People", "number"), H("gross", "Gross (INR)", "money"), H("net", "Net pay (INR)", "money"), H("link", "Open")],
      rows: await tx`select to_char(r.period_month, 'Mon YYYY') as month, g.name as pay_group, r.status, (select count(*)::int from payroll_lines l where l.run_id = r.id) as people,
          coalesce((select sum(l.gross_paise) from payroll_lines l where l.run_id = r.id), 0)::bigint as gross, coalesce((select sum(l.net_paise) from payroll_lines l where l.run_id = r.id), 0)::bigint as net,
          '/payroll/runs/' || r.id as link
        from payroll_runs r join pay_groups g on g.id = r.pay_group_id where r.status <> 'rolled_back' order by r.period_month desc, g.name`,
      note: "Amounts are totals across everyone in the run; the register itself is restricted to payroll roles.",
    }),
  },
];

export const reportByKey = (key: string) => STANDARD_REPORTS.find((r) => r.key === key) ?? null;
