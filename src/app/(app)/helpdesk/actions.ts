"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as hd from "@/server/modules/helpdesk/service";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { MAX_ATTACHMENTS } from "@/server/modules/helpdesk/rules";
import type { TicketDetailDTO } from "@/features/helpdesk/types";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const str = (form: FormData, k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };

/** Attachments from a form: at most 3, each within the upload limit (checked again by type and signature in the service). */
async function filesFrom(form: FormData): Promise<hd.UploadedFile[] | string> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} files.`;
  const out: hd.UploadedFile[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) return `${f.name} is larger than 5 MB.`;
    out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

export async function raiseTicketAction(form: FormData) {
  const files = await filesFrom(form);
  if (typeof files === "string") return bad(files, "files");
  const categoryId = str(form, "categoryId");
  if (!uuid.safeParse(categoryId).success) return bad("Pick a category.", "categoryId");
  return runAction((tx, actor) => hd.raiseTicket(tx, actor, { categoryId, title: str(form, "title").slice(0, 200), description: str(form, "description").slice(0, 6000), files }));
}

export async function replyTicketAction(form: FormData) {
  const files = await filesFrom(form);
  if (typeof files === "string") return bad(files, "files");
  const id = str(form, "ticketId");
  if (!uuid.safeParse(id).success) return bad("Ticket not found.");
  return runAction((tx, actor) => hd.reply(tx, actor, id, { body: str(form, "body").slice(0, 6000), internal: str(form, "internal") === "1", files }));
}

export async function ticketStatusAction(id: string, action: "start" | "close" | "reopen") {
  if (!uuid.safeParse(id).success || !["start", "close", "reopen"].includes(action)) return bad("Ticket not found.");
  return runAction((tx, actor) => hd.changeStatus(tx, actor, id, action));
}

export async function assignTicketAction(id: string, assigneeId: string | null) {
  if (!uuid.safeParse(id).success || (assigneeId !== null && !uuid.safeParse(assigneeId).success)) return bad("Ticket not found.");
  return runAction((tx, actor) => hd.assign(tx, actor, id, assigneeId));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function ticketDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Ticket not found.");
  return runAction(async (tx, actor): Promise<TicketDetailDTO> => {
    const d = await hd.ticketDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This ticket doesn't exist or isn't shared with you.");
    const t = d.ticket;
    return {
      ticket: {
        id: t.id, ref: t.ref, title: t.title, category: t.category, status: t.status, priority: t.priority, requester: t.requester, requester_id: t.requester_id,
        assignee: t.assignee, assignee_id: t.assignee_id, created_at: t.created_at.toISOString(), reopened_count: t.reopened_count, sla: t.sla,
        first_response_due_at: iso(t.first_response_due_at), first_responded_at: iso(t.first_responded_at), resolution_due_at: iso(t.resolution_due_at), closed_at: iso(t.closed_at),
      },
      messages: d.messages.map((m) => ({ ...m, created_at: m.created_at.toISOString() })),
      role: d.role, can: d.can, agents: d.agents,
    };
  }, { refresh: false });
}
