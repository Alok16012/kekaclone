import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor, Branding } from "@/server/auth/session";
import { saveFile } from "@/server/storage";
import { audit } from "@/server/modules/audit/service";
import { assertFeature, assertWorkspace } from "./gate";
import { accentProblem, BG_MAX_BYTES, imageProblem, LOGO_MAX_BYTES, LOGO_MIMES, loginNoteProblem } from "./branding-rules";

export async function brandingSettings(tx: Tx): Promise<Branding> {
  const [t] = await tx<{ branding: Branding | null }[]>`select branding from tenants`;
  return t?.branding ?? {};
}

/** Accent colours and the sign-in note. Clearing the accent restores erp's default blue. */
export async function saveBranding(tx: Tx, actor: Actor, input: { accent: string; accentDark: string; loginNote: string }) {
  assertWorkspace(actor, "settings.org");
  assertFeature(actor, "branding");
  const accent = input.accent.trim().toLowerCase(), accentDark = input.accentDark.trim().toLowerCase(), loginNote = input.loginNote.trim();
  if (accent) { const p = accentProblem(accent, "light"); if (p) throw new AppError("invalid", p, "accent"); }
  if (accentDark) { const p = accentProblem(accentDark, "dark"); if (p) throw new AppError("invalid", p, "accentDark"); }
  const np = loginNoteProblem(loginNote);
  if (np) throw new AppError("invalid", np, "loginNote");
  const patch = { accent: accent || null, accent_dark: accentDark || null, login_note: loginNote || null };
  await tx`update tenants set branding = branding || ${tx.json(patch)} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "branding.update", diff: patch });
}

/** Company logo (PNG/JPEG/WebP, up to 512 KB). Stored through the file module; served publicly at /brand/logo. */
export async function saveLogo(tx: Tx, actor: Actor, file: { name: string; mime: string; bytes: Uint8Array }) {
  assertWorkspace(actor, "settings.org");
  assertFeature(actor, "branding");
  if (!LOGO_MIMES.has(file.mime)) throw new AppError("invalid", "Upload a PNG, JPEG or WebP image.", "logo");
  if (file.bytes.byteLength > LOGO_MAX_BYTES) throw new AppError("invalid", "Keep the logo under 512 KB.", "logo");
  if (file.bytes.byteLength < 16) throw new AppError("invalid", "That file looks empty.", "logo");
  const ext = file.mime === "image/png" ? "png" : file.mime === "image/webp" ? "webp" : "jpg";
  const id = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: file.name.slice(0, 120) || `logo.${ext}`, mime: file.mime, bytes: file.bytes, ext });
  await tx`update tenants set branding = branding || ${tx.json({ logo_file_id: id })} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "branding.logo", diff: { fileId: id } });
  return id;
}

export async function removeLogo(tx: Tx, actor: Actor) {
  assertWorkspace(actor, "settings.org");
  await tx`update tenants set branding = branding - 'logo_file_id' where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "branding.logo", diff: { fileId: null } });
}

/** Sign-in page background image (PNG/JPEG/WebP up to 2 MB, bytes checked). Served publicly at /brand/background. */
export async function saveLoginBackground(tx: Tx, actor: Actor, file: { name: string; mime: string; bytes: Uint8Array }) {
  assertWorkspace(actor, "settings.org");
  assertFeature(actor, "branding");
  const p = imageProblem({ mime: file.mime, size: file.bytes.byteLength, head: file.bytes.subarray(0, 16) }, BG_MAX_BYTES, "background");
  if (p) throw new AppError("invalid", p, "background");
  const ext = file.mime === "image/png" ? "png" : file.mime === "image/webp" ? "webp" : "jpg";
  const id = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: file.name.slice(0, 120) || `login-background.${ext}`, mime: file.mime, bytes: file.bytes, ext });
  await tx`update tenants set branding = branding || ${tx.json({ login_bg_file_id: id })} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "branding.background", diff: { fileId: id } });
  return id;
}

export async function removeLoginBackground(tx: Tx, actor: Actor) {
  assertWorkspace(actor, "settings.org");
  await tx`update tenants set branding = branding - 'login_bg_file_id' where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action: "branding.background", diff: { fileId: null } });
}

export async function backgroundFile(tx: Tx, branding: Branding | undefined) {
  const id = branding?.login_bg_file_id;
  if (!id) return null;
  const [f] = await tx<{ storage_key: string; mime: string }[]>`select storage_key, mime from files where id = ${id}`;
  return f ?? null;
}

/** The logo file for the public /brand/logo route: only the file the tenant row points at, nothing else. */
export async function logoFile(tx: Tx, branding: Branding | undefined) {
  const id = branding?.logo_file_id;
  if (!id) return null;
  const [f] = await tx<{ storage_key: string; mime: string }[]>`select storage_key, mime from files where id = ${id}`;
  return f ?? null;
}
