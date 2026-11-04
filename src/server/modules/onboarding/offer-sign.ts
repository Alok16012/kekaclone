import "server-only";
import { createHash, randomInt } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import { sha256 } from "@/server/auth/password";
import { queueEmail } from "@/server/email";
import { appendSignaturePage, renderLetterPdf } from "@/server/modules/documents/pdf";
import { auditLine, maskEmail } from "@/server/modules/documents/esign-rules";
import { emitEvent } from "@/server/modules/automations/service";
import { letterDate, safeFileName } from "@/server/modules/documents/rules";
import { saveFile, storage } from "@/server/storage";

/**
 * Joiner portal: the new joiner reads and signs their offer letter (an offer-type letter HR issued to them) with
 * their typed full name plus a 6-digit code emailed to their personal address — the same e-sign method the hiring
 * portal uses. The signed copy is the original PDF with an acceptance page added; it lands in their documents.
 * A letter already signed in the hiring portal just shows as signed, with a download. Letters issued to them as a
 * candidate (before they were converted to an employee) count too.
 * Integration with erp Sign: the acceptance is stamped with the same signature page erp Sign uses (method, time, IP
 * and the SHA-256 of the document the joiner saw), and a letter HR has already sent out through erp Sign is signed
 * through that link only, so one letter never has two competing signing flows.
 */
const OTP_MINUTES = 10, OTP_TRIES = 5;
const ERP_SIGN_MSG = "This letter was sent to you for signing by email. Use the signing link in that email.";

type Letter = { id: string; title: string; status: string; file_id: string | null; signed_name: string | null; signed_at: Date | null; sign_otp_hash: string | null; sign_otp_expires_at: Date | null; sign_otp_attempts: number; created_at: Date };
type Joiner = { id: string; first_name: string; display_name: string; personal_email: string | null };

async function joinerFor(tx: Tx, token: string): Promise<Joiner | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const [p] = await tx<Joiner[]>`
    select e.id, e.first_name, e.display_name, e.personal_email::text from lifecycle_processes p join employees e on e.id = p.employee_id
    where p.portal_token_hash = ${sha256(token)} and p.kind = 'onboarding' and p.status = 'in_progress' and p.portal_expires_at > now()`;
  return p ?? null;
}

async function letterFor(tx: Tx, employeeId: string, lock = false): Promise<Letter | null> {
  const [g] = await tx<Letter[]>`
    select g.id, t.name as title, g.status, g.file_id, coalesce(g.signed_name, g.data->>'signed_name') as signed_name,
      coalesce(g.signed_at, (g.data->>'signed_at')::timestamptz) as signed_at, g.sign_otp_hash, g.sign_otp_expires_at, g.sign_otp_attempts, g.created_at
    from generated_letters g join letter_templates t on t.id = g.template_id
    where (g.employee_id = ${employeeId} or g.candidate_id in (select c.id from candidates c where c.employee_id = ${employeeId})) and t.kind = 'offer' and g.status in ('published','pending_signature','signed') and g.file_id is not null
    order by g.created_at desc limit 1 ${lock ? tx`for update of g` : tx``}`;
  return g ?? null;
}

const mask = maskEmail;

/** True when HR sent this letter out through erp Sign and that request is still open. */
async function inErpSign(tx: Tx, letterId: string) {
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from signature_requests where letter_id = ${letterId} and status in ('pending','waiting')`;
  return (r?.n ?? 0) > 0;
}

export type JoinerOffer = { title: string; signed: boolean; viaErpSign: boolean; signed_name: string | null; signed_at: string | null; codeSent: boolean; sendTo: string | null; fullName: string };

export async function joinerOffer(tx: Tx, token: string): Promise<JoinerOffer | null> {
  const j = await joinerFor(tx, token);
  if (!j) return null;
  const g = await letterFor(tx, j.id);
  if (!g) return null;
  return {
    title: g.title, signed: g.status === "signed", viaErpSign: g.status !== "signed" && await inErpSign(tx, g.id), signed_name: g.signed_name, signed_at: g.signed_at ? new Date(g.signed_at).toISOString() : null,
    codeSent: !!g.sign_otp_expires_at && g.sign_otp_expires_at > new Date(), sendTo: j.personal_email ? mask(j.personal_email) : null, fullName: j.display_name,
  };
}

export async function requestJoinerSignCode(tx: Tx, tenant: { id: string; name: string }, token: string) {
  const j = await joinerFor(tx, token);
  if (!j) throw new AppError("invalid", "This link doesn't work anymore. Ask HR for a fresh one.");
  const g = await letterFor(tx, j.id, true);
  if (!g || g.status === "signed") throw new AppError("conflict", "There's no letter waiting for your signature.");
  if (await inErpSign(tx, g.id)) throw new AppError("conflict", ERP_SIGN_MSG);
  if (!j.personal_email) throw new AppError("invalid", "We need your personal email to send the code. Ask HR to add it.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await tx`update generated_letters set sign_otp_hash = ${sha256(`${g.id}:${code}`)}, sign_otp_expires_at = now() + make_interval(mins => ${OTP_MINUTES}), sign_otp_attempts = 0 where id = ${g.id}`;
  await queueEmail(tx, tenant.id, {
    kind: "onboarding.sign_code", to: j.personal_email,
    subject: `Your code to sign your offer letter: ${code}`,
    html: `<p>Hi ${j.first_name.replace(/[<>&"]/g, "")},</p><p>Use this code to sign your offer letter from ${tenant.name.replace(/[<>&"]/g, "")}: <strong>${code}</strong></p><p>It works for ${OTP_MINUTES} minutes. If you didn't ask for it, ignore this email.</p>`,
    text: `Hi ${j.first_name},\n\nUse this code to sign your offer letter from ${tenant.name}: ${code}\n\nIt works for ${OTP_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
  });
  return { sentTo: mask(j.personal_email) };
}

const norm = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Original letter + the erp Sign signature page (typed signature, audit line, document hash), as one PDF. */
async function signedPdf(original: Uint8Array, a: { company: string; name: string; email: string; ip: string | null; at: Date; title: string; hash: string }) {
  const block = { name: a.name, title: "Offer accepted", method: "typed" as const, typedName: a.name, png: null, hash: a.hash,
    audit: auditLine({ signedAt: a.at, ip: a.ip, method: "typed", email: maskEmail(a.email) }) };
  try {
    return await appendSignaturePage(original, [block], { company: a.company, title: a.title });
  } catch {
    // an unreadable original: keep the acceptance on its own (the original stays in their documents)
    const stamp = a.at.toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
    return renderLetterPdf({ html: `<h3>Acceptance</h3><p>I have read this letter and I accept the offer.</p><p><strong>${a.name.replace(/[<>&"]/g, "")}</strong></p><p>${block.audit.replace(/[<>&"]/g, "")}</p>`, title: a.title, company: a.company, footer: `${a.title} · signed ${stamp} IST` });
  }
}

/** Sign with the typed full name + the emailed code. Wrong codes are counted (returned, not thrown, so the count is saved). */
export async function signJoinerOffer(tx: Tx, tenant: { id: string; name: string }, token: string, input: { typedName: string; code: string; ip: string | null }): Promise<{ ok: true } | { ok: false; error: string; field?: string }> {
  const j = await joinerFor(tx, token);
  if (!j) return { ok: false, error: "This link doesn't work anymore. Ask HR for a fresh one." };
  const g = await letterFor(tx, j.id, true);
  if (!g || g.status === "signed") return { ok: false, error: "There's no letter waiting for your signature." };
  if (await inErpSign(tx, g.id)) return { ok: false, error: ERP_SIGN_MSG };
  if (norm(input.typedName) !== norm(j.display_name)) return { ok: false, error: `Type your full name exactly as shown: ${j.display_name}.`, field: "typedName" };
  if (!g.sign_otp_hash || !g.sign_otp_expires_at || g.sign_otp_expires_at <= new Date() || g.sign_otp_attempts >= OTP_TRIES) return { ok: false, error: "Ask for a new code first.", field: "code" };
  if (!/^\d{6}$/.test(input.code.trim()) || sha256(`${g.id}:${input.code.trim()}`) !== g.sign_otp_hash) {
    await tx`update generated_letters set sign_otp_attempts = sign_otp_attempts + 1 where id = ${g.id}`;
    const left = OTP_TRIES - g.sign_otp_attempts - 1;
    return { ok: false, error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new code.", field: "code" };
  }
  const [f] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${g.file_id}`;
  const original = f ? await storage().get(f.storage_key) : null;
  const name = input.typedName.trim().slice(0, 120);
  const at = new Date();
  const stamp = at.toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const hash = original ? createHash("sha256").update(original).digest("hex") : null;
  const bytes = original ? await signedPdf(original, { company: tenant.name, name, email: j.personal_email ?? "", ip: input.ip, at, title: `${g.title} · ${j.display_name}`, hash: hash! })
    : await renderLetterPdf({ html: `<h3>Acceptance</h3><p>I accept the offer in ${g.title}.</p><p><strong>${name.replace(/[<>&"]/g, "")}</strong></p><p>Signed ${stamp} IST.</p>`, title: g.title, company: tenant.name, footer: `${g.title} · signed ${stamp} IST` });
  const fileId = await saveFile(tx, { tenantId: tenant.id, userId: null, name: safeFileName(`${g.title} - ${j.display_name} (signed).pdf`), mime: "application/pdf", bytes, ext: "pdf" });
  const [done] = await tx<{ id: string }[]>`
    update generated_letters set status = 'signed', file_id = ${fileId}, signed_name = ${name}, signed_at = now(), signed_ip = ${input.ip?.slice(0, 64) ?? null}, sign_otp_hash = null
    where id = ${g.id} and status <> 'signed' returning id`;
  if (!done) return { ok: false, error: "This letter was already signed." };
  await tx`insert into employee_documents (tenant_id, employee_id, category, doc_type, file_id, status, verified_at)
           values (${tenant.id}, ${j.id}, 'letter', ${`${g.title} (signed)`.slice(0, 120)}, ${fileId}, 'verified', now())`;
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${tenant.id}, ${j.id}, 'letter_signed', current_date, ${tx.json({ letter_id: g.id, title: g.title })}, null)`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenant.id}, null, 'generated_letter', ${g.id}, 'letter.signed', ${tx.json({ via: "joiner_portal", signed_name: name, ip: input.ip ?? null, hash })})`;
  await emitEvent(tx, tenant.id, "letter.signed", { employeeId: j.id, occurrence: g.id, link: `/people/${j.id}?tab=documents`, vars: { "letter.title": g.title } });   // Settings → Automations
  return { ok: true };
}

/** The letter file for the portal's download link (the signed copy once signed). */
export async function joinerOfferFile(tx: Tx, token: string) {
  const j = await joinerFor(tx, token);
  if (!j) return null;
  const g = await letterFor(tx, j.id);
  if (!g?.file_id) return null;
  const [f] = await tx<{ storage_key: string; name: string; mime: string }[]>`select storage_key, name, mime from files where id = ${g.file_id}`;
  return f ?? null;
}

export const signedOn = (iso: string) => letterDate(iso.slice(0, 10));
