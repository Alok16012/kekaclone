import "server-only";
import { randomBytes } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { queueEmail, appUrl } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { saveFile } from "@/server/storage";
import { validateUpload } from "@/server/modules/documents/rules";
import { todayIn, type ISODate } from "@/lib/dates";
import { renderCertificatePdf } from "./pdf";
import {
  cleanContent, describeRule, dueDateFor, embedUrl, enrollmentState, isComplete, learnerQuiz, nextModule, parseRule, percentDone, reminderDue, ruleMatches, sanitizeReading, scoreQuiz,
  validateCourse, validateModule, type EnrollmentState, type ModuleContent, type ModuleKind, type Placed, type Progress, type QuizContent, type Rule,
} from "./rules";

export const LEARN_ADMIN = "learn.admin";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Courses and assignment rules are company-wide: authoring needs learn.admin with no department / location scope. */
export const canAdminLearn = (actor: Actor) => canFor(actor, LEARN_ADMIN, EVERYWHERE);
export const hasLearnReports = (actor: Actor) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(LEARN_ADMIN) || g.permissions.includes("reports.read"));
const canReportOn = (actor: Actor, p: Placement) => canFor(actor, LEARN_ADMIN, p) || canFor(actor, "reports.read", p);
function assertAdmin(actor: Actor) { if (!canAdminLearn(actor)) throw new AppError("forbidden", "Only learning admins for the whole company can do this."); }
const first = (p: { field: string; message: string }[]) => { if (p.length) throw new AppError("invalid", p[0].message, p[0].field); };
const uuidOk = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export type UploadedFile = { name: string; bytes: Uint8Array };

// ---------- courses (admin) ----------
export type CourseRow = {
  id: string; title: string; description: string | null; status: "draft" | "published" | "archived"; certificate: boolean; estimated_minutes: number | null; published_at: Date | null;
  modules: number; enrolled: number; completed: number; overdue: number; assignments: number; updated_at: Date;
};

export async function listCourses(tx: Tx, actor: Actor): Promise<CourseRow[]> {
  if (!hasLearnReports(actor)) throw new AppError("forbidden", "Course administration is for learning admins.");
  const today = todayIn();
  return tx<CourseRow[]>`
    select c.id, c.title, c.description, c.status, c.certificate, c.estimated_minutes, c.published_at, c.updated_at,
      (select count(*)::int from course_modules m where m.course_id = c.id) as modules,
      (select count(*)::int from enrollments e where e.course_id = c.id) as enrolled,
      (select count(*)::int from enrollments e where e.course_id = c.id and e.completed_at is not null) as completed,
      (select count(*)::int from enrollments e where e.course_id = c.id and e.completed_at is null and e.due_date < ${today}) as overdue,
      (select count(*)::int from course_assignments a where a.course_id = c.id and a.is_active) as assignments
    from courses c order by (c.status = 'archived'), c.updated_at desc`;
}

export type ModuleRow = { id: string; kind: ModuleKind; title: string; content: ModuleContent; file_id: string | null; file_name: string | null; position: number };
export type AssignmentRow = { id: string; name: string; rule: Rule; description: string; due_in_days: number | null; reminder_days_before: number | null; is_active: boolean; enrolled: number; created_at: Date };
export type CourseAdmin = { course: CourseRow; modules: ModuleRow[]; assignments: AssignmentRow[]; canEdit: boolean };

export async function courseAdmin(tx: Tx, actor: Actor, id: string): Promise<CourseAdmin | null> {
  const course = (await listCourses(tx, actor)).find((c) => c.id === id);
  if (!course) return null;
  const [modules, rawAssignments] = await Promise.all([
    tx<ModuleRow[]>`select m.id, m.kind, m.title, m.content, m.file_id, f.name as file_name, m.position from course_modules m left join files f on f.id = m.file_id where m.course_id = ${id} order by m.position`,
    tx<{ id: string; name: string; rule: unknown; due_in_days: number | null; reminder_days_before: number | null; is_active: boolean; enrolled: number; created_at: Date }[]>`
      select a.id, a.name, a.rule, a.due_in_days, a.reminder_days_before, a.is_active, (select count(*)::int from enrollments e where e.assignment_id = a.id) as enrolled, a.created_at
      from course_assignments a where a.course_id = ${id} order by a.created_at`,
  ]);
  const names = await ruleNames(tx, rawAssignments.map((a) => parseRule(a.rule)).filter((r): r is Rule => !!r));
  const assignments: AssignmentRow[] = rawAssignments.map((a) => {
    const rule = parseRule(a.rule) ?? { kind: "everyone" as const };
    return { ...a, rule, description: describeRule(rule, (ids) => ids.map((i) => names.get(i) ?? "").filter(Boolean)) };
  });
  return { course, modules, assignments, canEdit: canAdminLearn(actor) };
}

async function ruleNames(tx: Tx, rules: Rule[]) {
  const ids = [...new Set(rules.flatMap((r) => ("ids" in r ? r.ids : [])))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await tx<{ id: string; label: string }[]>`
    select id, display_name as label from employees where id = any(${ids}::uuid[])
    union all select id, name from departments where id = any(${ids}::uuid[])
    union all select id, name from locations where id = any(${ids}::uuid[])
    union all select id, title from designations where id = any(${ids}::uuid[])`;
  for (const r of rows) out.set(r.id, r.label);
  return out;
}

export type CourseInput = { title: string; description: string | null; certificate: boolean; estimatedMinutes: number | null };
export async function saveCourse(tx: Tx, actor: Actor, id: string | null, input: CourseInput) {
  assertAdmin(actor);
  const title = input.title.trim(), description = input.description?.trim() || null;
  first(validateCourse({ title, description, estimatedMinutes: input.estimatedMinutes }));
  if (id) {
    const [r] = await tx<{ id: string }[]>`update courses set title = ${title}, description = ${description}, certificate = ${input.certificate}, estimated_minutes = ${input.estimatedMinutes}, updated_at = now() where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Course not found.");
    await audit(tx, actor, { entityType: "course", entityId: id, action: "update", diff: { title } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into courses (tenant_id, title, description, certificate, estimated_minutes, created_by) values (${actor.tenant.id}, ${title}, ${description}, ${input.certificate}, ${input.estimatedMinutes}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "course", entityId: r.id, action: "create", diff: { title } });
  return r;
}

export async function setCourseStatus(tx: Tx, actor: Actor, id: string, status: "draft" | "published" | "archived") {
  assertAdmin(actor);
  const [c] = await tx<{ status: string; modules: number }[]>`select status, (select count(*)::int from course_modules m where m.course_id = c.id) as modules from courses c where id = ${id} for update`;
  if (!c) throw new AppError("not_found", "Course not found.");
  if (status === "published" && !c.modules) throw new AppError("invalid", "Add at least one module before publishing.");
  if (c.status === status) return;
  await tx`update courses set status = ${status}, published_at = case when ${status} = 'published' then coalesce(published_at, now()) else published_at end, updated_at = now() where id = ${id}`;
  if (status === "published") await applyAssignments(tx, actor.tenant.id, todayIn(), id);
  await audit(tx, actor, { entityType: "course", entityId: id, action: "status", diff: { from: c.status, to: status } });
}

export async function deleteCourse(tx: Tx, actor: Actor, id: string) {
  assertAdmin(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from enrollments where course_id = ${id}`;
  if (n) throw new AppError("invalid", "People are enrolled in this course. Archive it instead.");
  const r = await tx`delete from courses where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Course not found.");
  await audit(tx, actor, { entityType: "course", entityId: id, action: "delete" });
}

// ---------- modules ----------
const VIDEO_SIG = (b: Uint8Array) => (b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp") || (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3);

async function storeModuleFile(tx: Tx, actor: Actor, kind: ModuleKind, f: UploadedFile) {
  if (kind === "video") {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["mp4", "webm", "m4v"].includes(ext) || !VIDEO_SIG(f.bytes)) throw new AppError("invalid", "Upload an .mp4 or .webm video, or paste a link instead.", "file");
    if (f.bytes.byteLength > 5 * 1024 * 1024) throw new AppError("invalid", "Uploads are limited to 5 MB; paste a YouTube or Vimeo link for longer videos.", "file");
    return saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: f.name.slice(0, 120), mime: ext === "webm" ? "video/webm" : "video/mp4", bytes: f.bytes, ext });
  }
  const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
  if (!v.ok) throw new AppError("invalid", v.error, "file");
  return saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: f.bytes, ext: v.name.split(".").pop() ?? "" });
}

export async function saveModule(tx: Tx, actor: Actor, courseId: string, id: string | null, input: { title: string; kind: ModuleKind; content: unknown; file: UploadedFile | null }) {
  assertAdmin(actor);
  const [c] = await tx<{ id: string }[]>`select id from courses where id = ${courseId}`;
  if (!c) throw new AppError("not_found", "Course not found.");
  const existing = id ? (await tx<{ id: string; file_id: string | null; kind: ModuleKind }[]>`select id, file_id, kind from course_modules where id = ${id} and course_id = ${courseId}`)[0] : null;
  if (id && !existing) throw new AppError("not_found", "Module not found.");
  const keepsFile = !!existing?.file_id && existing.kind === input.kind;
  first(validateModule({ title: input.title, kind: input.kind, content: input.content, hasFile: !!input.file || keepsFile }));
  const content = cleanContent(input.kind, input.content);
  if (content.kind === "text") content.html = sanitizeReading(content.html);
  const fileId = input.file ? await storeModuleFile(tx, actor, input.kind, input.file) : keepsFile ? existing!.file_id : null;
  const title = input.title.trim();
  if (existing) {
    await tx`update course_modules set title = ${title}, kind = ${input.kind}, content = ${tx.json(content as never)}, file_id = ${fileId}, updated_at = now() where id = ${existing.id}`;
    await tx`update courses set updated_at = now() where id = ${courseId}`;
    return { id: existing.id };
  }
  const [{ pos }] = await tx<{ pos: number }[]>`select coalesce(max(position), 0) + 1 as pos from course_modules where course_id = ${courseId}`;
  const [r] = await tx<{ id: string }[]>`insert into course_modules (tenant_id, course_id, kind, title, content, file_id, position) values (${actor.tenant.id}, ${courseId}, ${input.kind}, ${title}, ${tx.json(content as never)}, ${fileId}, ${pos}) returning id`;
  await tx`update courses set updated_at = now() where id = ${courseId}`;
  return r;
}

export async function deleteModule(tx: Tx, actor: Actor, courseId: string, id: string) {
  assertAdmin(actor);
  const r = await tx`delete from course_modules where id = ${id} and course_id = ${courseId}`;
  if (!r.count) throw new AppError("not_found", "Module not found.");
  const rest = await tx<{ id: string }[]>`select id from course_modules where course_id = ${courseId} order by position`;
  for (const [i, m] of rest.entries()) await tx`update course_modules set position = ${i + 1} where id = ${m.id}`;
  await recomputeProgress(tx, courseId);
}

export async function moveModule(tx: Tx, actor: Actor, courseId: string, id: string, dir: -1 | 1) {
  assertAdmin(actor);
  const list = await tx<{ id: string }[]>`select id from course_modules where course_id = ${courseId} order by position`;
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) throw new AppError("not_found", "Module not found.");
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  for (const [k, m] of list.entries()) await tx`update course_modules set position = ${k + 1} where id = ${m.id}`;
}

/** After modules change, percentages for in-progress learners are recomputed (completed ones keep their certificate). */
async function recomputeProgress(tx: Tx, courseId: string) {
  const ids = (await tx<{ id: string }[]>`select id from course_modules where course_id = ${courseId} order by position`).map((m) => m.id);
  const rows = await tx<{ id: string; progress: Progress }[]>`select id, progress from enrollments where course_id = ${courseId} and completed_at is null`;
  for (const e of rows) await tx`update enrollments set percent = ${percentDone(ids, e.progress)} where id = ${e.id}`;
}

// ---------- assignments ----------
export type AssignmentInput = { name: string; rule: unknown; dueInDays: number | null; reminderDaysBefore: number | null; isActive: boolean };

export async function saveAssignment(tx: Tx, actor: Actor, courseId: string, id: string | null, input: AssignmentInput) {
  assertAdmin(actor);
  const [c] = await tx<{ id: string; status: string }[]>`select id, status from courses where id = ${courseId}`;
  if (!c) throw new AppError("not_found", "Course not found.");
  const rule = parseRule(input.rule);
  if (!rule) throw new AppError("invalid", "Pick who this assignment is for.", "rule");
  if ("ids" in rule) {
    const table = rule.kind === "people" ? "employees" : rule.kind === "departments" ? "departments" : rule.kind === "locations" ? "locations" : "designations";
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)} where id = any(${rule.ids}::uuid[])`;
    if (n !== rule.ids.length) throw new AppError("invalid", "Some of the selections no longer exist.", "rule");
  }
  if (input.dueInDays != null && (!Number.isInteger(input.dueInDays) || input.dueInDays < 1 || input.dueInDays > 365)) throw new AppError("invalid", "Due in 1–365 days, or leave it empty.", "dueInDays");
  if (input.reminderDaysBefore != null && (!Number.isInteger(input.reminderDaysBefore) || input.reminderDaysBefore < 0 || input.reminderDaysBefore > 90)) throw new AppError("invalid", "Remind 0–90 days before the due date.", "reminderDaysBefore");
  if (input.reminderDaysBefore != null && input.dueInDays == null) throw new AppError("invalid", "Reminders need a due date.", "reminderDaysBefore");
  const name = input.name.trim().slice(0, 120) || "Assignment";
  let aid = id;
  if (id) {
    const [r] = await tx<{ id: string }[]>`update course_assignments set name = ${name}, rule = ${tx.json(rule)}, due_in_days = ${input.dueInDays}, reminder_days_before = ${input.reminderDaysBefore}, is_active = ${input.isActive}, updated_at = now()
      where id = ${id} and course_id = ${courseId} returning id`;
    if (!r) throw new AppError("not_found", "Assignment not found.");
  } else {
    const [r] = await tx<{ id: string }[]>`insert into course_assignments (tenant_id, course_id, name, rule, due_in_days, reminder_days_before, is_active, created_by)
      values (${actor.tenant.id}, ${courseId}, ${name}, ${tx.json(rule)}, ${input.dueInDays}, ${input.reminderDaysBefore}, ${input.isActive}, ${actor.userId}) returning id`;
    aid = r.id;
  }
  await audit(tx, actor, { entityType: "course", entityId: courseId, action: id ? "assignment.update" : "assignment.create", diff: { assignment_id: aid, rule, due_in_days: input.dueInDays } });
  const enrolled = c.status === "published" && input.isActive ? await applyAssignments(tx, actor.tenant.id, todayIn(), courseId) : 0;
  return { id: aid!, enrolled };
}

export async function deleteAssignment(tx: Tx, actor: Actor, courseId: string, id: string) {
  assertAdmin(actor);
  const r = await tx`delete from course_assignments where id = ${id} and course_id = ${courseId}`;
  if (!r.count) throw new AppError("not_found", "Assignment not found.");
}

/**
 * Enrol everyone an active rule matches on a published course. Safe to run again (unique course + person).
 * Returns how many people were newly enrolled.
 */
export async function applyAssignments(tx: Tx, tenantId: string, today: ISODate, courseId?: string) {
  const rules = await tx<{ id: string; course_id: string; title: string; rule: unknown; due_in_days: number | null }[]>`
    select a.id, a.course_id, c.title, a.rule, a.due_in_days from course_assignments a join courses c on c.id = a.course_id
    where a.is_active and c.status = 'published' and (${courseId ?? null}::uuid is null or a.course_id = ${courseId ?? null}::uuid)`;
  if (!rules.length) return 0;
  const people = await tx<Placed[]>`select id, department_id, location_id, designation_id, joining_date::text from employees where status in ('active','notice')`;
  let n = 0;
  for (const a of rules) {
    const rule = parseRule(a.rule);
    if (!rule) continue;
    for (const p of people) {
      if (!ruleMatches(rule, p, today)) continue;
      const r = await tx`insert into enrollments (tenant_id, course_id, employee_id, assignment_id, due_date) values (${tenantId}, ${a.course_id}, ${p.id}, ${a.id}, ${dueDateFor(today, a.due_in_days)}) on conflict (course_id, employee_id) do nothing`;
      if (r.count) {
        n++;
        await notifyEmployee(tx, tenantId, p.id, "learn.assigned", "A course was assigned to you", `${a.title}${a.due_in_days ? ` · due in ${a.due_in_days} days` : ""}`, `/learn/courses/${a.course_id}`);
      }
    }
  }
  return n;
}

/** Enrol specific people by hand (admin). */
export async function enrollPeople(tx: Tx, actor: Actor, courseId: string, employeeIds: string[], dueInDays: number | null) {
  assertAdmin(actor);
  const [c] = await tx<{ id: string; title: string; status: string }[]>`select id, title, status from courses where id = ${courseId}`;
  if (!c) throw new AppError("not_found", "Course not found.");
  if (c.status !== "published") throw new AppError("invalid", "Publish the course before enrolling people.");
  if (!employeeIds.length || !employeeIds.every(uuidOk)) throw new AppError("invalid", "Pick at least one person.", "employeeIds");
  const people = await tx<{ id: string }[]>`select id from employees where id = any(${employeeIds}::uuid[]) and status <> 'relieved'`;
  if (people.length !== new Set(employeeIds).size) throw new AppError("invalid", "Some of the people you picked have left or don't exist.", "employeeIds");
  const today = todayIn();
  let n = 0;
  for (const p of people) {
    const r = await tx`insert into enrollments (tenant_id, course_id, employee_id, due_date) values (${actor.tenant.id}, ${courseId}, ${p.id}, ${dueDateFor(today, dueInDays)}) on conflict (course_id, employee_id) do nothing`;
    if (r.count) { n++; await notifyEmployee(tx, actor.tenant.id, p.id, "learn.assigned", "A course was assigned to you", c.title, `/learn/courses/${courseId}`); }
  }
  await audit(tx, actor, { entityType: "course", entityId: courseId, action: "enroll", diff: { employeeIds, due_in_days: dueInDays } });
  return n;
}

// ---------- learner ----------
export type MyCourse = {
  course_id: string; title: string; description: string | null; estimated_minutes: number | null; certificate: boolean; modules: number;
  enrollment_id: string; due_date: string | null; percent: number; completed_at: Date | null; certificate_file_id: string | null; state: EnrollmentState; last_activity_at: Date | null;
};

export async function myCourses(tx: Tx, actor: Actor, today = todayIn()): Promise<MyCourse[]> {
  const rows = await tx<Omit<MyCourse, "state">[]>`
    select c.id as course_id, c.title, c.description, c.estimated_minutes, c.certificate, (select count(*)::int from course_modules m where m.course_id = c.id) as modules,
      e.id as enrollment_id, e.due_date::text, e.percent::float as percent, e.completed_at, e.certificate_file_id, e.last_activity_at
    from enrollments e join courses c on c.id = e.course_id where e.employee_id = ${actor.employeeId} and c.status <> 'draft'
    order by (e.completed_at is not null), e.due_date nulls last, c.title`;
  return rows.map((r) => ({ ...r, state: enrollmentState(r, today) }));
}

export type PlayerModule = {
  id: string; kind: ModuleKind; title: string; position: number; done_at: string | null;
  video: { kind: "iframe" | "file"; src: string } | null; html: string | null; link: string | null; file: { id: string; name: string; mime: string } | null;
  quiz: { questions: { id: string; text: string; options: string[] }[]; pass_pct: number } | null; best_attempt: { score: number; total: number; pct: number; passed: boolean } | null;
};
export type Player = {
  course: { id: string; title: string; description: string | null; certificate: boolean; estimated_minutes: number | null };
  enrollment: { id: string; due_date: string | null; percent: number; completed_at: string | null; certificate_file_id: string | null; state: EnrollmentState };
  modules: PlayerModule[]; next_module_id: string | null;
};

/** Everything the player needs; null when the person isn't enrolled (admins may preview any course). */
export async function player(tx: Tx, actor: Actor, courseId: string, today = todayIn()): Promise<Player | null> {
  const [course] = await tx<(Player["course"] & { status: string })[]>`select id, title, description, certificate, estimated_minutes, status from courses where id = ${courseId}`;
  if (!course) return null;
  const [enr] = await tx<{ id: string; due_date: string | null; percent: number; completed_at: Date | null; certificate_file_id: string | null; progress: Progress }[]>`
    select id, due_date::text, percent::float as percent, completed_at, certificate_file_id, progress from enrollments where course_id = ${courseId} and employee_id = ${actor.employeeId}`;
  if (!enr && !canAdminLearn(actor)) return null;
  if (!enr && course.status === "draft" && !canAdminLearn(actor)) return null;
  const mods = await tx<{ id: string; kind: ModuleKind; title: string; content: ModuleContent; position: number; file_id: string | null; file_name: string | null; file_mime: string | null }[]>`
    select m.id, m.kind, m.title, m.content, m.position, m.file_id, f.name as file_name, f.mime as file_mime from course_modules m left join files f on f.id = m.file_id where m.course_id = ${courseId} order by m.position`;
  const attempts = enr ? await tx<{ module_id: string; score: number; total: number; passed: boolean }[]>`
    select distinct on (module_id) module_id, score, total, passed from quiz_attempts where enrollment_id = ${enr.id} order by module_id, passed desc, score desc, created_at desc` : [];
  const progress = enr?.progress ?? {};
  const ids = mods.map((m) => m.id);
  const modules: PlayerModule[] = mods.map((m) => {
    const c = m.content;
    const best = attempts.find((a) => a.module_id === m.id);
    return {
      id: m.id, kind: m.kind, title: m.title, position: m.position, done_at: progress.modules?.[m.id]?.done_at ?? null,
      video: m.kind === "video" ? (c.kind === "video" && c.url ? embedUrl(c.url) : m.file_id ? { kind: "file", src: `/learn/files/${m.file_id}` } : null) : null,
      html: c.kind === "text" ? c.html : null,
      link: c.kind === "link" ? c.url : null,
      file: m.kind === "document" && m.file_id ? { id: m.file_id, name: m.file_name ?? "Document", mime: m.file_mime ?? "application/octet-stream" } : null,
      quiz: c.kind === "quiz" ? learnerQuiz(c) : null,
      best_attempt: best ? { score: best.score, total: best.total, pct: best.total ? Math.round((best.score / best.total) * 100) : 0, passed: best.passed } : null,
    };
  });
  return {
    course: { id: course.id, title: course.title, description: course.description, certificate: course.certificate, estimated_minutes: course.estimated_minutes },
    enrollment: enr ? { id: enr.id, due_date: enr.due_date, percent: enr.percent, completed_at: enr.completed_at?.toISOString() ?? null, certificate_file_id: enr.certificate_file_id, state: enrollmentState(enr, today) }
      : { id: "", due_date: null, percent: 0, completed_at: null, certificate_file_id: null, state: "not_started" },
    modules, next_module_id: nextModule(ids, progress),
  };
}

async function markDone(tx: Tx, actor: Actor, courseId: string, moduleId: string) {
  const [enr] = await tx<{ id: string; progress: Progress; completed_at: Date | null }[]>`select id, progress, completed_at from enrollments where course_id = ${courseId} and employee_id = ${actor.employeeId} for update`;
  if (!enr) throw new AppError("forbidden", "You're not enrolled in this course.");
  const ids = (await tx<{ id: string }[]>`select id from course_modules where course_id = ${courseId} order by position`).map((m) => m.id);
  if (!ids.includes(moduleId)) throw new AppError("not_found", "Module not found.");
  const progress: Progress = { ...enr.progress, modules: { ...(enr.progress.modules ?? {}), [moduleId]: enr.progress.modules?.[moduleId] ?? { done_at: new Date().toISOString() } } };
  const percent = percentDone(ids, progress);
  const complete = isComplete(ids, progress) && !enr.completed_at;
  await tx`update enrollments set progress = ${tx.json(progress as never)}, percent = ${percent}, last_activity_at = now(), completed_at = case when ${complete} then now() else completed_at end, updated_at = now() where id = ${enr.id}`;
  if (complete) await issueCertificate(tx, actor, enr.id);
  return { percent, completed: complete || !!enr.completed_at };
}

export async function completeModule(tx: Tx, actor: Actor, courseId: string, moduleId: string) {
  const [m] = await tx<{ kind: ModuleKind }[]>`select kind from course_modules where id = ${moduleId} and course_id = ${courseId}`;
  if (!m) throw new AppError("not_found", "Module not found.");
  if (m.kind === "quiz") throw new AppError("invalid", "Pass the quiz to complete this module.");
  return markDone(tx, actor, courseId, moduleId);
}

export async function submitQuiz(tx: Tx, actor: Actor, courseId: string, moduleId: string, answers: unknown) {
  const [m] = await tx<{ content: ModuleContent }[]>`select content from course_modules where id = ${moduleId} and course_id = ${courseId} and kind = 'quiz'`;
  if (!m || m.content.kind !== "quiz") throw new AppError("not_found", "Quiz not found.");
  const [enr] = await tx<{ id: string }[]>`select id from enrollments where course_id = ${courseId} and employee_id = ${actor.employeeId}`;
  if (!enr) throw new AppError("forbidden", "You're not enrolled in this course.");
  const result = scoreQuiz(m.content as QuizContent, answers);
  await tx`insert into quiz_attempts (tenant_id, enrollment_id, module_id, answers, score, total, passed) values (${actor.tenant.id}, ${enr.id}, ${moduleId}, ${tx.json(result.answers)}, ${result.score}, ${result.total}, ${result.passed})`;
  await tx`update enrollments set last_activity_at = now() where id = ${enr.id}`;
  const done = result.passed ? await markDone(tx, actor, courseId, moduleId) : null;
  return { ...result, percent: done?.percent ?? null, completed: done?.completed ?? false };
}

const certCode = () => randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "X").slice(0, 8).toUpperCase();

async function issueCertificate(tx: Tx, actor: Actor, enrollmentId: string) {
  const [e] = await tx<{ id: string; certificate: boolean; title: string; name: string; company: string; code: string | null }[]>`
    select e.id, c.certificate, c.title, p.display_name as name, t.name as company, e.certificate_code as code
    from enrollments e join courses c on c.id = e.course_id join employees p on p.id = e.employee_id join tenants t on t.id = e.tenant_id where e.id = ${enrollmentId}`;
  if (!e?.certificate) return null;
  const code = e.code ?? certCode();
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const bytes = await renderCertificatePdf({ name: e.name, course: e.title, company: e.company, date, code });
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `Certificate - ${e.title.slice(0, 60)}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
  await tx`update enrollments set certificate_file_id = ${fileId}, certificate_code = ${code} where id = ${enrollmentId}`;
  await notifyEmployee(tx, actor.tenant.id, actor.employeeId, "learn.completed", "Course completed", `${e.title} · your certificate is ready`, "/me/learn");
  return fileId;
}

/** Module files for enrolled learners (published course) and admins; certificates for their owner, admins and HR in scope. */
export async function learnFileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; course_id: string | null; course_status: string | null; cert_employee: string | null; placement: Placement | null }[]>`
    select f.id, f.storage_key, f.name, f.mime,
      (select m.course_id from course_modules m where m.file_id = f.id limit 1) as course_id,
      (select c.status from course_modules m join courses c on c.id = m.course_id where m.file_id = f.id limit 1) as course_status,
      (select e.employee_id from enrollments e where e.certificate_file_id = f.id limit 1) as cert_employee,
      (select json_build_object('department_id', p.department_id, 'location_id', p.location_id, 'legal_entity_id', p.legal_entity_id, 'business_unit_id', p.business_unit_id)
         from enrollments e join employees p on p.id = e.employee_id where e.certificate_file_id = f.id limit 1) as placement
    from files f where f.id = ${fileId}`;
  if (!f) return null;
  if (f.course_id) {
    if (canAdminLearn(actor)) return f;
    if (f.course_status !== "published") return null;
    const [e] = await tx<{ id: string }[]>`select id from enrollments where course_id = ${f.course_id} and employee_id = ${actor.employeeId}`;
    return e ? f : null;
  }
  if (f.cert_employee) {
    if (f.cert_employee === actor.employeeId || canAdminLearn(actor) || (f.placement && canReportOn(actor, f.placement))) return f;
  }
  return null;
}

// ---------- reminders (job) ----------
export async function sendReminders(tx: Tx, tenant: { id: string; name: string; subdomain: string }, today = todayIn()) {
  const rows = await tx<{ id: string; employee_id: string; email: string | null; name: string; title: string; course_id: string; due_date: string | null; completed_at: Date | null; reminded_on: string | null; days_before: number | null }[]>`
    select e.id, e.employee_id, u.email::text as email, p.display_name as name, c.title, c.id as course_id, e.due_date::text, e.completed_at, e.reminded_on::text,
      coalesce(a.reminder_days_before, 3) as days_before
    from enrollments e join courses c on c.id = e.course_id join employees p on p.id = e.employee_id left join users u on u.id = p.user_id left join course_assignments a on a.id = e.assignment_id
    where c.status = 'published' and e.completed_at is null and e.due_date is not null and p.status in ('active','notice')`;
  let n = 0;
  for (const r of rows) {
    if (!reminderDue(r, r.days_before, today)) continue;
    const overdue = r.due_date! < today;
    const body = overdue ? `${r.title} was due on ${r.due_date}. Please finish it.` : `${r.title} is due on ${r.due_date}.`;
    await notifyEmployee(tx, tenant.id, r.employee_id, overdue ? "learn.overdue" : "learn.due", overdue ? "Course overdue" : "Course due soon", body, `/learn/courses/${r.course_id}`);
    if (r.email) {
      await queueEmail(tx, tenant.id, { kind: "learn.reminder", to: r.email, ...simpleEmail({ company: tenant.name, subject: `${overdue ? "Overdue" : "Reminder"}: ${r.title}`, heading: overdue ? "A course is overdue" : "A course is due soon",
        paragraphs: [`Hi ${r.name.split(" ")[0]}, ${body}`], button: { label: "Open the course", url: appUrl(tenant.subdomain, `/learn/courses/${r.course_id}`) } }) });
    }
    await tx`update enrollments set reminded_on = ${today} where id = ${r.id}`;
    n++;
  }
  return n;
}

// ---------- reports ----------
export type CompletionRow = { course_id: string; course: string; department: string | null; enrolled: number; completed: number; in_progress: number; overdue: number; not_started: number; avg_score: number | null };
export type OverdueRow = { enrollment_id: string; employee_id: string; employee: string; department: string | null; course: string; due_date: string; percent: number; days_overdue: number };
export type LearnerRow = { enrollment_id: string; employee_id: string; employee: string; number: string; department: string | null; course: string; due_date: string | null; percent: number; completed_at: Date | null; state: EnrollmentState; best_score: number | null };

/** Completion by course (and by course × department), overdue people, and the full enrolment list, limited to people in the reader's scope. */
export async function completionReport(tx: Tx, actor: Actor, filters: { courseId?: string | null; departmentId?: string | null } = {}, today = todayIn()) {
  if (!hasLearnReports(actor)) throw new AppError("forbidden", "Learning reports are for learning admins and report readers.");
  const rows = await tx<(LearnerRow & Placement & { course_id: string })[]>`
    select e.id as enrollment_id, p.id as employee_id, p.display_name as employee, p.employee_number as number, d.name as department, c.title as course, c.id as course_id,
      e.due_date::text, e.percent::float as percent, e.completed_at, p.department_id, p.location_id, p.legal_entity_id, p.business_unit_id,
      (select max(round(q.score::numeric * 100 / nullif(q.total, 0)))::int from quiz_attempts q where q.enrollment_id = e.id) as best_score
    from enrollments e join courses c on c.id = e.course_id join employees p on p.id = e.employee_id left join departments d on d.id = p.department_id
    where c.status <> 'draft' and (${filters.courseId ?? null}::uuid is null or c.id = ${filters.courseId ?? null}::uuid) and (${filters.departmentId ?? null}::uuid is null or p.department_id = ${filters.departmentId ?? null}::uuid)
    order by c.title, p.display_name`;
  const mine = rows.filter((r) => canReportOn(actor, r)).map((r) => ({ ...r, state: enrollmentState(r, today) }));
  const key = (r: { course_id: string; department: string | null }, byDept: boolean) => (byDept ? `${r.course_id}|${r.department ?? ""}` : r.course_id);
  const group = (byDept: boolean) => {
    const m = new Map<string, CompletionRow>();
    for (const r of mine) {
      const k = key(r, byDept);
      const g = m.get(k) ?? { course_id: r.course_id, course: r.course, department: byDept ? r.department ?? "No department" : null, enrolled: 0, completed: 0, in_progress: 0, overdue: 0, not_started: 0, avg_score: null };
      g.enrolled++;
      if (r.state === "completed") g.completed++; else if (r.state === "overdue") g.overdue++; else if (r.state === "in_progress") g.in_progress++; else g.not_started++;
      m.set(k, g);
    }
    for (const g of m.values()) {
      const scores = mine.filter((r) => key(r, byDept) === key(g as never, byDept) && r.best_score != null).map((r) => r.best_score!);
      g.avg_score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    }
    return [...m.values()];
  };
  const overdue: OverdueRow[] = mine.filter((r) => r.state === "overdue").map((r) => ({
    enrollment_id: r.enrollment_id, employee_id: r.employee_id, employee: r.employee, department: r.department, course: r.course, due_date: r.due_date!, percent: r.percent,
    days_overdue: Math.round((Date.parse(today) - Date.parse(r.due_date!)) / 86400000),
  }));
  return { byCourse: group(false), byDepartment: group(true), overdue, learners: mine.map((r): LearnerRow => ({ enrollment_id: r.enrollment_id, employee_id: r.employee_id, employee: r.employee, number: r.number, department: r.department, course: r.course, due_date: r.due_date, percent: r.percent, completed_at: r.completed_at, state: r.state, best_score: r.best_score })) };
}
