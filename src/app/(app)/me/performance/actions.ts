"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import * as goals from "@/server/modules/performance/goals";
import * as fb from "@/server/modules/performance/feedback";
import * as one from "@/server/modules/performance/one-on-ones";
import * as rv from "@/server/modules/performance/reviews";
import * as pip from "@/server/modules/performance/pip";
import { setMySkill } from "@/server/modules/performance/settings";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const isId = (id: unknown): id is string => uuid.safeParse(id).success;

// ---------- goals ----------
export async function createGoalAction(raw: unknown) {
  return runAction(async (tx, actor) => { await goals.createObjective(tx, actor, raw); });
}
export async function updateGoalAction(id: string, raw: unknown) {
  if (!isId(id)) return bad("Goal not found.");
  return runAction((tx, actor) => goals.updateObjective(tx, actor, id, raw));
}
export async function deleteGoalAction(id: string) {
  if (!isId(id)) return bad("Goal not found.");
  return runAction((tx, actor) => goals.deleteObjective(tx, actor, id));
}
export async function closeGoalAction(id: string, closed: boolean) {
  if (!isId(id)) return bad("Goal not found.");
  return runAction((tx, actor) => goals.setClosed(tx, actor, id, closed));
}
/** Check-in with up to 3 files (multipart). Fields: id, status, comment, progress, kr:<id> = value. */
export async function checkInAction(form: FormData) {
  const id = form.get("id");
  if (!isId(id)) return bad("Goal not found.");
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 3) return bad("Attach up to 3 files.", "files");
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) return bad("Each file must be 5 MB or smaller.", "files");
  const num = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const keyResults: { id: string; current: number }[] = [];
  for (const [k, v] of form.entries()) {
    if (!k.startsWith("kr:")) continue;
    const n = num(v);
    if (n == null) return bad("Enter a number for every key result.", "keyResults");
    keyResults.push({ id: k.slice(3), current: n });
  }
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return runAction(async (tx, actor) => {
    const r = await goals.checkIn(tx, actor, id, { status: String(form.get("status") ?? ""), comment: String(form.get("comment") ?? "") || null, progress: num(form.get("progress")), keyResults }, uploads);
    return { progress: r.progress };
  });
}
export async function goalDetailAction(id: string) {
  if (!isId(id)) return bad("Goal not found.");
  return runAction(async (tx, actor) => {
    const d = await goals.goalDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This goal isn't available.");
    return d;
  }, { refresh: false });
}

// ---------- feedback ----------
export async function giveFeedbackAction(raw: unknown) { return runAction(async (tx, actor) => { await fb.giveFeedback(tx, actor, raw); }); }
export async function requestFeedbackAction(raw: unknown) { return runAction((tx, actor) => fb.requestFeedback(tx, actor, raw)); }
export async function respondFeedbackAction(id: string, raw: unknown) {
  if (!isId(id)) return bad("Request not found.");
  return runAction(async (tx, actor) => { await fb.respondToRequest(tx, actor, id, raw); });
}
export async function declineFeedbackAction(id: string) {
  if (!isId(id)) return bad("Request not found.");
  return runAction((tx, actor) => fb.declineRequest(tx, actor, id));
}
export async function addNoteAction(raw: unknown) { return runAction(async (tx, actor) => { await fb.addNote(tx, actor, raw); }); }
export async function deleteFeedbackAction(id: string) {
  if (!isId(id)) return bad("Feedback not found.");
  return runAction((tx, actor) => fb.deleteOwn(tx, actor, id));
}
export async function feedbackAboutAction(employeeId: string) {
  if (!isId(employeeId)) return bad("Person not found.");
  return runAction((tx, actor) => fb.feedbackAbout(tx, actor, employeeId), { refresh: false });
}

// ---------- 1:1s ----------
export async function scheduleOneOnOneAction(raw: unknown) { return runAction(async (tx, actor) => { const m = await one.scheduleOneOnOne(tx, actor, raw); return { id: m.id }; }); }
export async function meetingDetailAction(id: string) {
  if (!isId(id)) return bad("Meeting not found.");
  return runAction(async (tx, actor) => {
    const d = await one.meetingDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This meeting isn't available.");
    return d;
  }, { refresh: false });
}
export async function addMeetingItemAction(meetingId: string, raw: unknown) {
  if (!isId(meetingId)) return bad("Meeting not found.");
  return runAction(async (tx, actor) => { await one.addItem(tx, actor, meetingId, raw); });
}
export async function setActionDoneAction(itemId: string, done: boolean) {
  if (!isId(itemId)) return bad("Item not found.");
  return runAction((tx, actor) => one.setActionDone(tx, actor, itemId, done));
}
export async function deleteMeetingItemAction(itemId: string) {
  if (!isId(itemId)) return bad("Item not found.");
  return runAction((tx, actor) => one.deleteItem(tx, actor, itemId));
}
export async function saveMeetingNotesAction(id: string, notes: string) {
  if (!isId(id) || typeof notes !== "string") return bad("Meeting not found.");
  return runAction((tx, actor) => one.saveSharedNotes(tx, actor, id, notes));
}
export async function completeMeetingAction(id: string) {
  if (!isId(id)) return bad("Meeting not found.");
  return runAction((tx, actor) => one.completeMeeting(tx, actor, id));
}
export async function cancelMeetingAction(id: string, endSeries: boolean) {
  if (!isId(id)) return bad("Meeting not found.");
  return runAction((tx, actor) => one.cancelMeeting(tx, actor, id, !!endSeries));
}
export async function rescheduleMeetingAction(id: string, startsAt: string, durationMins: number) {
  if (!isId(id)) return bad("Meeting not found.");
  return runAction((tx, actor) => one.reschedule(tx, actor, id, String(startsAt), Number(durationMins)));
}

// ---------- reviews ----------
export async function saveReviewDraftAction(id: string, answers: unknown) {
  if (!isId(id)) return bad("Review not found.");
  return runAction((tx, actor) => rv.saveDraft(tx, actor, id, answers), { refresh: false });
}
export async function submitReviewAction(id: string, answers: unknown) {
  if (!isId(id)) return bad("Review not found.");
  return runAction((tx, actor) => rv.submitReview(tx, actor, id, answers));
}
export async function declineReviewAction(id: string) {
  if (!isId(id)) return bad("Review not found.");
  return runAction((tx, actor) => rv.declineReview(tx, actor, id));
}
export async function nominatePeersAction(cycleId: string, revieweeId: string, peerIds: string[]) {
  if (!isId(cycleId) || !isId(revieweeId) || !Array.isArray(peerIds) || !peerIds.every(isId)) return bad("Pick people from the list.", "peerIds");
  return runAction((tx, actor) => rv.nominatePeers(tx, actor, cycleId, revieweeId, peerIds));
}
export async function decideNominationAction(id: string, approve: boolean) {
  if (!isId(id)) return bad("Nomination not found.");
  return runAction((tx, actor) => rv.decideNomination(tx, actor, id, !!approve));
}

// ---------- skills ----------
export async function setSkillAction(competencyId: string, proficiency: number | null) {
  if (!isId(competencyId)) return bad("Pick a skill.", "competencyId");
  return runAction((tx, actor) => setMySkill(tx, actor, competencyId, proficiency == null ? null : Number(proficiency)));
}

// ---------- PIP ----------
export async function createPipAction(raw: unknown) { return runAction(async (tx, actor) => { const r = await pip.createPip(tx, actor, raw); return { id: r.id }; }); }
export async function pipDetailAction(id: string) {
  if (!isId(id)) return bad("Plan not found.");
  return runAction(async (tx, actor) => {
    const d = await pip.pipDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This plan isn't available.");
    return d;
  }, { refresh: false });
}
export async function pipCheckInAction(id: string, raw: unknown) {
  if (!isId(id)) return bad("Plan not found.");
  return runAction((tx, actor) => pip.pipCheckIn(tx, actor, id, raw));
}
export async function pipGoalAction(id: string, goalId: string, met: boolean | null) {
  if (!isId(id) || typeof goalId !== "string") return bad("Plan not found.");
  return runAction((tx, actor) => pip.setPipGoal(tx, actor, id, goalId, met === null ? null : !!met));
}
export async function extendPipAction(id: string, endsOn: string, note: string) {
  if (!isId(id)) return bad("Plan not found.");
  return runAction((tx, actor) => pip.extendPip(tx, actor, id, String(endsOn), String(note ?? "")));
}
export async function closePipAction(id: string, outcome: "passed" | "failed" | "cancelled", note: string) {
  if (!isId(id) || !["passed", "failed", "cancelled"].includes(outcome)) return bad("Plan not found.");
  return runAction((tx, actor) => pip.closePip(tx, actor, id, outcome, String(note ?? "")));
}
