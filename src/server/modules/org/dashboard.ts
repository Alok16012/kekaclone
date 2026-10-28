import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { nextOccurrence } from "./dates";

type Person = Placement & {
  id: string; display_name: string; designation: string | null; department: string | null; joining_date: string; dob: string | null;
  login: "active" | "invited" | "not_invited" | "disabled"; probation_status: string; probation_end_date: string | null;
};

export type Dashboard = {
  scoped: boolean;
  headcount: { total: number; active: number; invited: number; notInvited: number; joinedThisMonth: number };
  pending: { leave: number; profileChanges: number; probationDue: number; scheduledChanges: number };
  byDepartment: { name: string; count: number }[];
  newJoiners: { id: string; name: string; title: string | null; joined: ISODate }[];
  probationDue: { id: string; name: string; ends: ISODate; overdue: boolean }[];
  celebrations: { id: string; name: string; kind: "birthday" | "anniversary"; on: ISODate; years?: number }[];
  logins: { day: ISODate; people: number }[];
};

/**
 * HR cockpit. Everything is computed over the people the actor may see, so a scoped admin
 * (e.g. "Engineering HR") gets numbers for their scope only.
 */
export async function orgDashboard(tx: Tx, actor: Actor): Promise<Dashboard> {
  const grants = actor.grants ?? [];
  const hasPeopleAccess = (g: { permissions: string[] }) => g.permissions.includes("*") || g.permissions.includes("employees.read") || g.permissions.includes("employees.write");
  if (!grants.some(hasPeopleAccess)) throw new AppError("forbidden", "The dashboard is for HR and admins.");
  const unscoped = grants.some((g) => hasPeopleAccess(g) && g.scopes.length === 0);
  const visible = (p: Placement) => canFor(actor, "employees.read", p) || canFor(actor, "employees.write", p);

  const all = await tx<Person[]>`
    select e.id, e.display_name, d.title as designation, dp.name as department, e.joining_date::text, e.dob::text,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, e.probation_status, e.probation_end_date::text,
      case when u.status = 'active' then 'active' when u.status = 'disabled' then 'disabled' when u.invited_at is not null then 'invited' else 'not_invited' end as login
    from employees e left join users u on u.id = e.user_id left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    where e.status <> 'relieved'`;
  const people = all.filter(visible);
  const ids = people.map((p) => p.id);
  const today = todayIn(), monthStart = today.slice(0, 8) + "01", in30 = addDaysISO(today, 30), in7 = addDaysISO(today, 7);

  const [[pending], logins] = await Promise.all([
    tx<{ leave: number; profile: number; scheduled: number }[]>`
      select (select count(*)::int from leave_requests where status = 'pending' and employee_id = any(${ids}::uuid[])) as leave,
             (select count(*)::int from profile_change_requests where status = 'pending' and employee_id = any(${ids}::uuid[])) as profile,
             (select count(*)::int from job_changes where status = 'scheduled' and employee_id = any(${ids}::uuid[])) as scheduled`,
    tx<{ day: string; people: number }[]>`
      select (l.created_at at time zone 'Asia/Kolkata')::date::text as day, count(distinct l.user_id)::int as people
      from login_events l join employees e on e.user_id = l.user_id
      where l.success and l.created_at > now() - interval '7 days' and e.id = any(${ids}::uuid[]) group by 1 order by 1`,
  ]);

  const byDept = new Map<string, number>();
  for (const p of people) { const k = p.department ?? "No department"; byDept.set(k, (byDept.get(k) ?? 0) + 1); }
  const probation = people
    .filter((p) => (p.probation_status === "in_probation" || p.probation_status === "extended") && p.probation_end_date && p.probation_end_date <= in30)
    .map((p) => ({ id: p.id, name: p.display_name, ends: p.probation_end_date!, overdue: p.probation_end_date! < today }))
    .sort((a, b) => a.ends.localeCompare(b.ends));
  const celebrations: Dashboard["celebrations"] = [];
  for (const p of people) {
    if (p.dob) { const on = nextOccurrence(p.dob.slice(5), today); if (on <= in7) celebrations.push({ id: p.id, name: p.display_name, kind: "birthday", on }); }
    if (p.joining_date < today) {
      const on = nextOccurrence(p.joining_date.slice(5), today);
      const years = Number(on.slice(0, 4)) - Number(p.joining_date.slice(0, 4));
      if (on <= in7 && years >= 1) celebrations.push({ id: p.id, name: p.display_name, kind: "anniversary", on, years });
    }
  }
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(today, i - 6));
  return {
    scoped: !unscoped,
    headcount: {
      total: people.length,
      active: people.filter((p) => p.login === "active").length,
      invited: people.filter((p) => p.login === "invited").length,
      notInvited: people.filter((p) => p.login === "not_invited").length,
      joinedThisMonth: people.filter((p) => p.joining_date >= monthStart && p.joining_date <= today).length,
    },
    pending: { leave: pending.leave, profileChanges: pending.profile, probationDue: probation.length, scheduledChanges: pending.scheduled },
    byDepartment: [...byDept].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    newJoiners: people.filter((p) => p.joining_date >= addDaysISO(today, -30) && p.joining_date <= in30)
      .sort((a, b) => b.joining_date.localeCompare(a.joining_date)).slice(0, 8)
      .map((p) => ({ id: p.id, name: p.display_name, title: p.designation, joined: p.joining_date })),
    probationDue: probation.slice(0, 8),
    celebrations: celebrations.sort((a, b) => a.on.localeCompare(b.on)),
    logins: days.map((day) => ({ day, people: logins.find((l) => l.day === day)?.people ?? 0 })),
  };
}
