"use server";
import { refresh } from "next/cache";
import { z } from "zod";
import { AppError, withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { portalComplete } from "@/server/modules/onboarding/service";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import type { ActionResult } from "@/server/action";

const uuid = z.uuid();
const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

/**
 * Joiner-portal mutations run without a session: the company comes from the subdomain only, and the token must
 * belong to an open onboarding of that company (checked under RLS inside the service).
 */
async function runPortal<T>(fn: (tenant: { id: string; name: string; status: string; subdomain: string }) => Promise<T>): Promise<ActionResult<T>> {
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return bad("This link isn't valid.");
  try {
    const data = await fn(tenant);
    refresh();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message, field: e.field };
    console.error(e);
    return bad("Something went wrong on our side. Please try again.");
  }
}

const complete = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done") }), z.object({ kind: z.literal("acknowledge") }), z.object({ kind: z.literal("field"), value: z.string().max(200) }),
]);
export async function portalCompleteAction(t: string, taskId: string, input: z.input<typeof complete>) {
  const p = complete.safeParse(input);
  if (!token.safeParse(t).success || !uuid.safeParse(taskId).success || !p.success) return bad("Check the details and try again.");
  return runPortal((tenant) => withTenant(tenant.id, (tx) => portalComplete(tx, tenant, t, taskId, p.data)));
}

export async function portalUploadAction(form: FormData) {
  const t = form.get("token"), taskId = form.get("taskId"), f = form.get("file");
  if (typeof t !== "string" || !token.safeParse(t).success || typeof taskId !== "string" || !uuid.safeParse(taskId).success) return bad("Task not found.");
  if (!(f instanceof File) || f.size === 0) return bad("Choose a file to upload.", "file");
  if (f.size > MAX_UPLOAD_BYTES) return bad("This file is larger than 5 MB.", "file");
  const file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  return runPortal((tenant) => withTenant(tenant.id, (tx) => portalComplete(tx, tenant, t, taskId, { kind: "upload", file })));
}
