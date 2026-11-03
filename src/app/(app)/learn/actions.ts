"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as learn from "@/server/modules/learn/service";
import { MODULE_KINDS, type ModuleKind } from "@/server/modules/learn/rules";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const str = (form: FormData, k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };

// ---------- learner ----------
export async function completeModuleAction(courseId: string, moduleId: string) {
  if (!uuid.safeParse(courseId).success || !uuid.safeParse(moduleId).success) return bad("Module not found.");
  return runAction((tx, actor) => learn.completeModule(tx, actor, courseId, moduleId));
}

export async function submitQuizAction(courseId: string, moduleId: string, answers: unknown) {
  if (!uuid.safeParse(courseId).success || !uuid.safeParse(moduleId).success) return bad("Quiz not found.");
  const a = z.array(z.number().int().min(0).max(20).nullable()).max(50).safeParse(answers);
  if (!a.success) return bad("Answer the questions first.");
  return runAction((tx, actor) => learn.submitQuiz(tx, actor, courseId, moduleId, a.data));
}

// ---------- authoring ----------
const courseSchema = z.object({ title: z.string().max(200), description: z.string().max(4000).nullable(), certificate: z.boolean(), estimatedMinutes: z.number().int().nullable() });
export async function saveCourseAction(id: string | null, input: unknown) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Course not found.");
  const p = courseSchema.safeParse(input);
  if (!p.success) return bad("Check the course details.", "title");
  return runAction((tx, actor) => learn.saveCourse(tx, actor, id, p.data));
}
export async function setCourseStatusAction(id: string, status: "draft" | "published" | "archived") {
  if (!uuid.safeParse(id).success || !["draft", "published", "archived"].includes(status)) return bad("Course not found.");
  return runAction((tx, actor) => learn.setCourseStatus(tx, actor, id, status));
}
export async function deleteCourseAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Course not found.");
  return runAction((tx, actor) => learn.deleteCourse(tx, actor, id));
}

/** Module form: title, kind, content as JSON, optional file (video or document, up to 5 MB). */
export async function saveModuleAction(form: FormData) {
  const courseId = str(form, "courseId"), id = str(form, "id") || null, kind = str(form, "kind");
  if (!uuid.safeParse(courseId).success || (id && !uuid.safeParse(id).success)) return bad("Course not found.");
  if (!(MODULE_KINDS as readonly string[]).includes(kind)) return bad("Pick a module type.", "kind");
  let content: unknown = {};
  try { content = JSON.parse(str(form, "content") || "{}"); } catch { return bad("The module content isn't valid.", "content"); }
  const f = form.get("file");
  let file: learn.UploadedFile | null = null;
  if (f instanceof File && f.size > 0) {
    if (f.size > MAX_UPLOAD_BYTES) return bad(`${f.name} is larger than 5 MB. Paste a link for larger videos.`, "file");
    file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  }
  return runAction((tx, actor) => learn.saveModule(tx, actor, courseId, id, { title: str(form, "title").slice(0, 200), kind: kind as ModuleKind, content, file }));
}
export async function deleteModuleAction(courseId: string, id: string) {
  if (!uuid.safeParse(courseId).success || !uuid.safeParse(id).success) return bad("Module not found.");
  return runAction((tx, actor) => learn.deleteModule(tx, actor, courseId, id));
}
export async function moveModuleAction(courseId: string, id: string, dir: -1 | 1) {
  if (!uuid.safeParse(courseId).success || !uuid.safeParse(id).success || ![-1, 1].includes(dir)) return bad("Module not found.");
  return runAction((tx, actor) => learn.moveModule(tx, actor, courseId, id, dir));
}

const assignmentSchema = z.object({ name: z.string().max(120), rule: z.unknown(), dueInDays: z.number().int().nullable(), reminderDaysBefore: z.number().int().nullable(), isActive: z.boolean() });
export async function saveAssignmentAction(courseId: string, id: string | null, input: unknown) {
  if (!uuid.safeParse(courseId).success || (id !== null && !uuid.safeParse(id).success)) return bad("Course not found.");
  const p = assignmentSchema.safeParse(input);
  if (!p.success) return bad("Check the assignment.", "rule");
  return runAction((tx, actor) => learn.saveAssignment(tx, actor, courseId, id, p.data));
}
export async function deleteAssignmentAction(courseId: string, id: string) {
  if (!uuid.safeParse(courseId).success || !uuid.safeParse(id).success) return bad("Assignment not found.");
  return runAction((tx, actor) => learn.deleteAssignment(tx, actor, courseId, id));
}
export async function enrollPeopleAction(courseId: string, employeeIds: string[], dueInDays: number | null) {
  if (!uuid.safeParse(courseId).success) return bad("Course not found.");
  const ids = z.array(uuid).min(1).max(200).safeParse(employeeIds);
  if (!ids.success) return bad("Pick at least one person.", "employeeIds");
  return runAction((tx, actor) => learn.enrollPeople(tx, actor, courseId, ids.data, dueInDays));
}
