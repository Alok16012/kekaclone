import "server-only";
import { emitEvent } from "@/server/modules/automations/service";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { todayIn } from "@/lib/dates";
import { startApproval } from "@/server/modules/approvals/service";
import { applyProfileChanges } from "./effects";
import { audit } from "@/server/modules/audit/service";
import { SECTIONS, FIELD_LABELS, type SectionKey } from "./fields";

export type Access = "self" | "manager" | "admin" | "colleague";

/** How the actor relates to the person: decides which fields they see and what they can change. */
export async function accessTo(tx: Tx, actor: Actor, employeeId: string): Promise<Access> {
  const [place] = await tx<Placement[]>`select department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${employeeId}`;
  if (place && canFor(actor, "employees.write", place)) return "admin";
  if (actor.employeeId === employeeId) return "self";
  const [m] = await tx<{ ok: boolean }[]>`select exists(select 1 from employees where id = ${employeeId} and (manager_id = ${actor.employeeId} or l2_manager_id = ${actor.employeeId})) as ok`;
  return m.ok ? "manager" : "colleague";
}

type Person = { id: string; display_name: string; designation: string | null };

export type Profile = {
  access: Access;
  employee: {
    id: string; employee_number: string; first_name: string; last_name: string | null; display_name: string; work_email: string;
    status: string; joining_date: string; worker_type: string; time_type: string;
    designation: string | null; designation_id: string | null; department: string | null; department_id: string | null;
    location: string | null; location_id: string | null; business_unit: string | null; legal_entity: string | null; band: string | null;
    probation_status: string; probation_end_date: string | null; is_private: boolean;
    login?: "active" | "invited" | "not_invited" | "disabled";
    // visible to self / manager / admin only
    personal?: { dob: string | null; gender: string | null; marital_status: string | null; blood_group: string | null; nationality: string | null };
    contact?: { personal_email: string | null; mobile: string | null };
    addresses?: { current?: Record<string, string | null>; permanent?: Record<string, string | null> };
    bio: { summary?: string | null; loveAboutJob?: string | null; hobbies?: string | null };
  };
  manager: Person | null; l2Manager: Person | null; dottedManager: Person | null;
  reportees: Person[]; peers: Person[];
  timeline: { kind: string; effective_date: string; data: Record<string, unknown>; actor: string | null }[];
  pendingChanges: { id: string; section: string; changes: Record<string, { old: unknown; new: unknown }>; created_at: Date }[];
  scheduledChanges: { id: string; kind: string; effective_date: string; changes: Record<string, unknown> }[];
  security?: { mode: "off" | "optional" | "required"; mine: boolean };
};

export async function getProfile(tx: Tx, actor: Actor, employeeId: string): Promise<Profile | null> {
  const [e] = await tx<(Omit<Profile["employee"], "personal" | "contact" | "login"> & { login: Profile["employee"]["login"]; dob: string | null; gender: string | null; marital_status: string | null; blood_group: string | null; nationality: string | null; personal_email: string | null; mobile: string | null; manager_id: string | null; l2_manager_id: string | null; dotted_manager_id: string | null })[]>`
    select e.id, e.employee_number, e.first_name, e.last_name, e.display_name, e.work_email, e.status, e.joining_date::text, e.worker_type, e.time_type,
      d.title as designation, e.designation_id, dp.name as department, e.department_id, l.name as location, e.location_id,
      bu.name as business_unit, le.name as legal_entity, b.name as band, e.probation_status, e.probation_end_date::text, e.is_private,
      e.dob::text, e.gender, e.marital_status, e.blood_group, e.nationality, e.personal_email, e.mobile, e.addresses, e.bio,
      e.manager_id, e.l2_manager_id, e.dotted_manager_id,
      (select case when u.status = 'active' then 'active' when u.status = 'disabled' then 'disabled' when u.invited_at is not null then 'invited' else 'not_invited' end from users u where u.id = e.user_id) as login
    from employees e
    left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join locations l on l.id = e.location_id left join business_units bu on bu.id = e.business_unit_id
    left join legal_entities le on le.id = e.legal_entity_id left join bands b on b.id = e.band_id
    where e.id = ${employeeId}`;
  if (!e) return null;
  const access = await accessTo(tx, actor, employeeId);
  const full = access !== "colleague";
  const person = (id: string | null) => id ? tx<Person[]>`select e.id, e.display_name, d.title as designation from employees e left join designations d on d.id = e.designation_id where e.id = ${id}`.then((r) => r[0] ?? null) : Promise.resolve(null);
  const [manager, l2Manager, dottedManager, reportees, peers, timeline, pendingChanges, scheduledChanges] = await Promise.all([
    person(e.manager_id), person(e.l2_manager_id), person(e.dotted_manager_id),
    tx<Person[]>`select e.id, e.display_name, d.title as designation from employees e left join designations d on d.id = e.designation_id where e.manager_id = ${employeeId} and e.status <> 'relieved' order by e.display_name`,
    e.manager_id ? tx<Person[]>`select e.id, e.display_name, d.title as designation from employees e left join designations d on d.id = e.designation_id where e.manager_id = ${e.manager_id} and e.id <> ${employeeId} and e.status <> 'relieved' order by e.display_name limit 12` : Promise.resolve([]),
    full ? tx<Profile["timeline"]>`select t.kind, t.effective_date::text, t.data, a.display_name as actor from timeline_events t left join users u on u.id = t.actor_user_id left join employees a on a.user_id = u.id where t.employee_id = ${employeeId} order by t.effective_date desc, t.created_at desc limit 50` : Promise.resolve([]),
    access === "self" || access === "admin" ? tx<Profile["pendingChanges"]>`select id, section, changes, created_at from profile_change_requests where employee_id = ${employeeId} and status = 'pending' order by created_at desc` : Promise.resolve([]),
    access === "admin" ? tx<Profile["scheduledChanges"]>`select id, kind, effective_date::text, changes from job_changes where employee_id = ${employeeId} and status = 'scheduled' order by effective_date` : Promise.resolve([]),
  ]);
  const employee: Profile["employee"] = {
    id: e.id, employee_number: e.employee_number, first_name: e.first_name, last_name: e.last_name, display_name: e.display_name, work_email: e.work_email,
    status: e.status, joining_date: e.joining_date, worker_type: e.worker_type, time_type: e.time_type, designation: e.designation, designation_id: e.designation_id,
    department: e.department, department_id: e.department_id, location: e.location, location_id: e.location_id, business_unit: e.business_unit,
    legal_entity: e.legal_entity, band: e.band, probation_status: e.probation_status, probation_end_date: e.probation_end_date, is_private: e.is_private,
    bio: e.bio ?? {},
    ...(access === "admin" ? { login: e.login } : {}),
    ...(full ? {
      personal: { dob: e.dob, gender: e.gender, marital_status: e.marital_status, blood_group: e.blood_group, nationality: e.nationality },
      contact: { personal_email: e.personal_email, mobile: e.mobile },
      addresses: (e.addresses ?? {}) as Profile["employee"]["addresses"],
    } : {}),
  };
  let security: Profile["security"];
  if (access === "self" || actor.employeeId === employeeId) {
    const [r] = await tx<{ mode: "off" | "optional" | "required" | null; mine: boolean }[]>`select (select auth_settings->>'mfa' from tenants) as mode, mfa_enabled as mine from users where id = ${actor.userId}`;
    security = { mode: r.mode ?? "optional", mine: r.mine };
  }
  return { access, employee, manager, l2Manager, dottedManager, reportees, peers, timeline, pendingChanges, scheduledChanges, security };
}

/**
 * Edit a profile section. Admins write directly. The person themselves writes 'about' directly and sends the
 * rest to HR for approval (one pending request per section; a new one replaces the old).
 */
export async function updateSection(tx: Tx, actor: Actor, employeeId: string, section: SectionKey, raw: unknown) {
  const access = await accessTo(tx, actor, employeeId);
  if (access !== "admin" && access !== "self") throw new AppError("forbidden", "You can't edit this profile.");
  const def = SECTIONS[section];
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid", parsed.error.issues[0].message, String(parsed.error.issues[0].path[0] ?? ""));
  const changes = parsed.data as Record<string, unknown>;

  if (access === "admin" || !def.needsApproval) {
    await applyProfileChanges(tx, actor.tenant.id, employeeId, changes, actor.userId);
    return { applied: true as const };
  }
  const cols = Object.keys(changes);
  const [current] = await tx<Record<string, unknown>[]>`select ${tx(cols)} from employees where id = ${employeeId}`;
  const diff = Object.fromEntries(cols.filter((c) => JSON.stringify(current[c] ?? null) !== JSON.stringify(changes[c] ?? null)).map((c) => [c, { old: current[c] ?? null, new: changes[c] ?? null }]));
  if (!Object.keys(diff).length) return { applied: true as const };

  // replace an earlier pending request for the same section
  const old = await tx<{ id: string }[]>`update profile_change_requests set status = 'cancelled' where employee_id = ${employeeId} and section = ${section} and status = 'pending' returning id`;
  for (const o of old) await tx`update approval_requests set status = 'cancelled' where entity_type = 'profile_change' and entity_id = ${o.id} and status = 'pending'`;

  const [req] = await tx<{ id: string }[]>`insert into profile_change_requests (tenant_id, employee_id, section, changes) values (${actor.tenant.id}, ${employeeId}, ${section}, ${tx.json(diff as never)}) returning id`;
  await audit(tx, actor, { entityType: "profile_change", entityId: req.id, action: "submit", diff: { section, changes: diff } });
  const summary = `${actor.name} · ${def.label} · ${Object.keys(diff).map((k) => FIELD_LABELS[k] ?? k).join(", ")}`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "profile_change", entityId: req.id, requesterId: employeeId, summary });
  if (status === "approved") await applyProfileChanges(tx, actor.tenant.id, employeeId, changes, actor.userId);
  return { applied: status === "approved", requestId: req.id };
}

export const JOB_FIELDS = ["department_id", "designation_id", "location_id", "manager_id", "l2_manager_id", "dotted_manager_id", "band_id", "worker_type", "time_type"] as const;
export type JobChangeInput = { kind: "transfer" | "promotion" | "manager_change" | "designation_change" | "other"; effectiveDate: string; changes: Partial<Record<(typeof JOB_FIELDS)[number], string | null>>; note?: string };

/** Transfer / promotion / manager change. Today or earlier → applied now; future → scheduled (applied by the daily job). */
export async function changeJob(tx: Tx, actor: Actor, employeeId: string, input: JobChangeInput) {
  if ((await accessTo(tx, actor, employeeId)) !== "admin") throw new AppError("forbidden", "Only HR can change job details.");
  const changes = Object.fromEntries(Object.entries(input.changes).filter(([k]) => (JOB_FIELDS as readonly string[]).includes(k)));
  if (!Object.keys(changes).length) throw new AppError("invalid", "Change at least one field.");
  if (changes.manager_id === employeeId) throw new AppError("invalid", "Someone can't report to themselves.", "manager_id");
  if (changes.manager_id) {
    // no reporting loops: the new manager must not report (directly or indirectly) to this person
    const [loop] = await tx<{ loop: boolean }[]>`
      with recursive up as (select id, manager_id, 1 as depth from employees where id = ${changes.manager_id}
        union all select e.id, e.manager_id, up.depth + 1 from employees e join up on e.id = up.manager_id where up.depth < 50)
      select exists(select 1 from up where id = ${employeeId}) as loop`;
    if (loop.loop) throw new AppError("invalid", "That would create a reporting loop: the new manager reports to this person.", "manager_id");
  }
  const [jc] = await tx<{ id: string }[]>`
    insert into job_changes (tenant_id, employee_id, kind, effective_date, changes, created_by)
    values (${actor.tenant.id}, ${employeeId}, ${input.kind}, ${input.effectiveDate}, ${tx.json({ ...changes, note: input.note ?? null } as never)}, ${actor.userId}) returning id`;
  if (input.effectiveDate <= todayIn()) await applyJobChange(tx, jc.id, actor.userId);
  else {
    const cols = Object.keys(changes);
    const [cur] = await tx<Record<string, unknown>[]>`select ${tx(cols)} from employees where id = ${employeeId}`;
    await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: "job_change_scheduled",
      diff: { kind: input.kind, effectiveDate: input.effectiveDate, changes: Object.fromEntries(cols.map((c) => [c, { old: cur[c] ?? null, new: changes[c] ?? null }])), note: input.note ?? null } });
  }
  return { id: jc.id, scheduled: input.effectiveDate > todayIn() };
}

export async function applyJobChange(tx: Tx, jobChangeId: string, actorUserId: string | null) {
  const [jc] = await tx<{ tenant_id: string; employee_id: string; kind: string; effective_date: string; changes: Record<string, string | null> }[]>`
    update job_changes set status = 'applied' where id = ${jobChangeId} and status = 'scheduled' returning tenant_id, employee_id, kind, effective_date::text, changes`;
  if (!jc) return;
  const { note, ...fields } = jc.changes;
  const cols = Object.keys(fields);
  const [before] = await tx<Record<string, unknown>[]>`select ${tx(cols)} from employees where id = ${jc.employee_id}`;
  await tx`update employees set ${tx(fields as Record<string, never>, cols)} where id = ${jc.employee_id}`;
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${jc.tenant_id}, ${jc.employee_id}, ${jc.kind}, ${jc.effective_date}, ${tx.json({ before, after: fields, note } as never)}, ${actorUserId})`;
  await audit(tx, { tenantId: jc.tenant_id, userId: actorUserId }, { entityType: "employee", entityId: jc.employee_id, action: "job_change",
    diff: { before, after: fields, kind: jc.kind, effectiveDate: jc.effective_date, note: note ?? null } });
  await emitEvent(tx, jc.tenant_id, "employee.transferred", { employeeId: jc.employee_id, occurrence: jobChangeId, facts: { "change.kind": jc.kind }, vars: { "change.kind": jc.kind, "change.effective_date": jc.effective_date } });
}

export async function cancelJobChange(tx: Tx, actor: Actor, id: string) {
  const [jc] = await tx<{ employee_id: string }[]>`select employee_id from job_changes where id = ${id}`;
  if (!jc || (await accessTo(tx, actor, jc.employee_id)) !== "admin") throw new AppError("forbidden", "Only HR can change job details.");
  const done = await tx`update job_changes set status = 'cancelled' where id = ${id} and status = 'scheduled' returning id`;
  if (done.length) await audit(tx, actor, { entityType: "employee", entityId: jc.employee_id, action: "job_change_cancelled", diff: { jobChangeId: id } });
}

/** Confirm or extend probation. Confirm ends it today (or on a given date); extend moves the end date. */
export async function setProbation(tx: Tx, actor: Actor, employeeId: string, input: { action: "confirm" | "extend" | "start"; date: string; note?: string }) {
  const access = await accessTo(tx, actor, employeeId);
  if (access !== "admin" && access !== "manager") throw new AppError("forbidden", "Only HR or the manager can update probation.");
  const status = input.action === "confirm" ? "confirmed" : input.action === "extend" ? "extended" : "in_probation";
  await tx`update employees set probation_status = ${status}, probation_end_date = ${input.date} where id = ${employeeId}`;
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${actor.tenant.id}, ${employeeId}, ${"probation_" + status}, ${input.action === "confirm" ? input.date : todayIn()}, ${tx.json({ until: input.date, note: input.note ?? null })}, ${actor.userId})`;
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: "probation", diff: { action: input.action, until: input.date, note: input.note ?? null } });
}

export async function lookups(tx: Tx) {
  const [departments, designations, locations, bands, people] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string }[]>`select id, name from bands order by rank, name`,
    tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
      select e.id, e.display_name as name, d.title, dp.name as department from employees e
      left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name`,
  ]);
  return { departments, designations, locations, bands, people };
}
