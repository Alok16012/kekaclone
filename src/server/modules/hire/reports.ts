import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { visibleJobIds } from "./access";
import { acceptanceRate, bySource, funnel, GROUP_ORDER, groupLabel, timeToHire, type FunnelApp, type StageGroup } from "./rules";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Funnel, sources, time to hire, offer acceptance and recruiter load for applications created in the range, on jobs the actor can see. */
export async function hiringReport(tx: Tx, actor: Actor, f: { from: string; to: string; jobId?: string | null }) {
  const ids = await visibleJobIds(tx, actor);
  const from = ISO.test(f.from) ? f.from : "2000-01-01", to = ISO.test(f.to) ? f.to : "2999-12-31";
  const jobFilter = f.jobId && /^[0-9a-f-]{36}$/i.test(f.jobId) ? f.jobId : null;
  const apps = await tx<{ id: string; status: string; source: string; created_at: Date; hired_at: Date | null; current: StageGroup; reached: StageGroup[] | null }[]>`
    select a.id, a.status, a.source, a.created_at, a.hired_at, s.stage_group as current,
      (select array_agg(distinct coalesce(ev.data->>'to_group', ev.data->>'from_group')) from application_events ev where ev.application_id = a.id and ev.kind in ('stage_change','rejected','applied','reopened','restored')) as reached
    from applications a join hiring_stages s on s.id = a.stage_id
    where a.created_at::date between ${from}::date and ${to}::date and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) and (${jobFilter}::uuid is null or a.job_id = ${jobFilter})`;
  const fa: FunnelApp[] = apps.map((a) => {
    const groups = [a.current, ...(a.reached ?? [])].filter((g): g is StageGroup => !!g && g in GROUP_ORDER && g !== "rejected");
    const furthest = groups.reduce<StageGroup>((m, g) => (GROUP_ORDER[g] > GROUP_ORDER[m] ? g : m), "sourced");
    return { furthest: a.status === "hired" ? "hired" : furthest, status: a.status, source: a.source, createdAt: a.created_at, hiredAt: a.hired_at };
  });
  const offers = await tx<{ status: string }[]>`
    select o.status from offers o join applications a on a.id = o.application_id
    where o.status not in ('revised') and o.created_at::date between ${from}::date and ${to}::date and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) and (${jobFilter}::uuid is null or a.job_id = ${jobFilter})`;
  const load = await tx<{ name: string; jobs: number; active: number; interviews: number }[]>`
    select e.display_name as name, count(distinct t.job_id)::int as jobs,
      (select count(*)::int from applications a where a.job_id = any(array_agg(t.job_id)) and a.status = 'active') as active,
      (select count(*)::int from interviews i join applications a on a.id = i.application_id where a.job_id = any(array_agg(t.job_id)) and i.status in ('scheduled','awaiting_candidate')) as interviews
    from job_team_members t join employees e on e.id = t.employee_id join jobs j on j.id = t.job_id
    where t.role = 'recruiter' and j.status in ('open','on_hold') and (${ids === null} or t.job_id = any(${ids ?? []}::uuid[]))
    group by e.id, e.display_name order by active desc, name`;
  const stageTime = await tx<{ group: StageGroup; days: number }[]>`
    select (ev.data->>'from_group') as group, round(avg(extract(epoch from ev.created_at - prev.created_at) / 86400)::numeric, 1)::float as days
    from application_events ev join applications a on a.id = ev.application_id
    join lateral (select p.created_at from application_events p where p.application_id = ev.application_id and p.created_at < ev.created_at and p.kind in ('applied','stage_change','reopened','restored') order by p.created_at desc limit 1) prev on true
    where ev.kind = 'stage_change' and ev.data ? 'from_group' and a.created_at::date between ${from}::date and ${to}::date
      and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) and (${jobFilter}::uuid is null or a.job_id = ${jobFilter})
    group by 1`;
  const jobs = await tx<{ id: string; title: string; status: string }[]>`select id, title, status from jobs where ${ids === null} or id = any(${ids ?? []}::uuid[]) order by title`;
  const reasons = await tx<{ reason: string; n: number }[]>`
    select reject_reason as reason, count(*)::int as n from applications a where a.status = 'rejected' and a.reject_reason is not null and a.created_at::date between ${from}::date and ${to}::date
      and (${ids === null} or a.job_id = any(${ids ?? []}::uuid[])) and (${jobFilter}::uuid is null or a.job_id = ${jobFilter}) group by 1 order by n desc limit 8`;
  return {
    total: apps.length, active: apps.filter((a) => a.status === "active").length,
    funnel: funnel(fa), sources: bySource(fa), timeToHire: timeToHire(fa), offers: acceptanceRate(offers), load,
    stageTime: stageTime.filter((s) => s.group in GROUP_ORDER).map((s) => ({ ...s, label: groupLabel(s.group) })).sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]),
    reasons, jobs,
  };
}
