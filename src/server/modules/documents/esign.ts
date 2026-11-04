import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { newToken, sha256 } from "@/server/auth/password";
import { appUrl, queueEmail } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { emitEvent } from "@/server/modules/automations/service";
import { saveFile, storage } from "@/server/storage";
import { safeFileName } from "./rules";
import { DOCS, canManageDocs } from "./service";
import { appendSignaturePage, type SignatureBlock } from "./pdf";
import { LINK_DAYS, OTP_MINUTES, allSigned, auditLine, canResend, maskEmail, nextSigner, normName, otpProblem, parsePngDataUrl, validateSigners, type SignerStatus } from "./esign-rules";

/**
 * erp Sign: a letter (or any employee document issued as a letter) can ask for signatures from people in order.
 * Each signer gets an emailed link, proves it's them with an emailed one-time code, and signs by typing their name
 * or drawing on a canvas. Every signature is stamped into the PDF with its audit trail (method, time, IP, the
 * SHA-256 of the document the signer saw) and the unsigned original is kept.
 */
type Req = {
  id: string; letter_id: string; signer_employee_id: string | null; signer_email: string; signer_name: string | null; title: string | null; sign_order: number; status: SignerStatus;
  signature_file_id: string | null; signed_ip: string | null; signed_at: Date | null; signature_type: "typed" | "drawn" | null; typed_name: string | null; document_hash: string | null;
  decline_reason: string | null; otp_hash: string | null; otp_expires_at: Date | null; otp_attempts: number; last_sent_at: Date | null; requested_by: string | null;
};
const COLS = (tx: Tx) => tx`id, letter_id, signer_employee_id, signer_email::text as signer_email, signer_name, title, sign_order, status, signature_file_id, signed_ip::text as signed_ip, signed_at, signature_type, typed_name, document_hash, decline_reason, otp_hash, otp_expires_at, otp_attempts, last_sent_at, requested_by`;

type Letter = { id: string; employee_id: string; file_id: string; original_file_id: string | null; status: string; doc_type: string; employee: string; data: { values?: Record<string, string | null> } };

async function letterOf(tx: Tx, letterId: string, lock = false): Promise<Letter> {
  const [l] = await tx<Letter[]>`
    select g.id, g.employee_id, g.file_id, g.original_file_id, g.status, coalesce(t.name, d.doc_type, 'Letter') as doc_type, e.display_name as employee, g.data
    from generated_letters g join employees e on e.id = g.employee_id left join letter_templates t on t.id = g.template_id
    left join employee_documents d on d.file_id = g.file_id
    where g.id = ${letterId} and g.employee_id is not null ${lock ? tx`for update of g` : tx``}`;
  if (!l) throw new AppError("not_found", "Letter not found.");
  return l;
}

async function guard(tx: Tx, actor: Actor, employeeId: string) {
  const [p] = await tx<Placement[]>`select department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${employeeId}`;
  if (!p || !canFor(actor, DOCS, p)) throw new AppError("forbidden", "You can't manage this person's letters.");
}

async function fileBytes(tx: Tx, fileId: string) {
  const [f] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${fileId}`;
  const bytes = f ? await storage().get(f.storage_key) : null;
  if (!bytes) throw new AppError("not_found", "The letter's file is missing.");
  return bytes;
}

// ---------- HR: start, resend, cancel, read ----------
export async function requestSignatures(tx: Tx, actor: Actor, letterId: string, rawSigners: unknown, message?: string | null) {
  const l = await letterOf(tx, letterId, true);
  await guard(tx, actor, l.employee_id);
  const v = validateSigners(rawSigners);
  if (!v.ok) throw new AppError("invalid", v.error, "signers");
  const [open] = await tx<{ id: string }[]>`select id from signature_requests where letter_id = ${letterId} and status in ('waiting','pending') limit 1`;
  if (open) throw new AppError("conflict", "Signatures were already requested for this letter. Cancel that request first.");
  if (l.status === "signed") throw new AppError("conflict", "This letter is already signed.");
  const original = await fileBytes(tx, l.original_file_id ?? l.file_id);
  const hash = createHash("sha256").update(original).digest("hex");
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  const rows: { id: string; order: number; token: string; email: string; name: string }[] = [];
  for (const [i, s] of v.signers.entries()) {
    let email = s.email, name = s.name;
    if (s.employeeId) {
      const [e] = await tx<{ work_email: string; display_name: string; status: string }[]>`select work_email::text as work_email, display_name, status from employees where id = ${s.employeeId}`;
      if (!e || e.status === "relieved") throw new AppError("invalid", "One of the signers has left the company.", "signers");
      email = e.work_email; name = e.display_name;
    }
    const token = newToken();
    const [r] = await tx<{ id: string }[]>`
      insert into signature_requests (tenant_id, letter_id, signer_employee_id, signer_email, signer_name, title, sign_order, status, token_hash, document_hash, requested_by)
      values (${actor.tenant.id}, ${letterId}, ${s.employeeId}, ${email!}, ${name}, ${s.title}, ${i + 1}, ${i === 0 ? "pending" : "waiting"}, ${sha256(token)}, ${hash}, ${actor.userId}) returning id`;
    rows.push({ id: r.id, order: i + 1, token, email: email!, name: name! });
  }
  await tx`update generated_letters set status = 'pending_signature', original_file_id = coalesce(original_file_id, file_id) where id = ${letterId}`;
  await sendLink(tx, { id: actor.tenant.id, name: t.name, subdomain: actor.tenant.subdomain }, rows[0], l, message?.trim().slice(0, 500) || null);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'generated_letter', ${letterId}, 'esign.request', ${tx.json({ signers: rows.map((r) => r.email), hash })})`;
  return { requested: rows.length, hash };
}

async function sendLink(tx: Tx, tenant: { id: string; name: string; subdomain: string }, r: { id: string; token: string; email: string; name: string }, l: Letter, message: string | null) {
  const mail = simpleEmail({
    company: tenant.name, subject: `Please sign: ${l.doc_type} for ${l.employee}`, heading: `${l.doc_type} is waiting for your signature`,
    paragraphs: [`Hi ${r.name.split(" ")[0]},`, `${tenant.name} has asked you to sign the ${l.doc_type.toLowerCase()} for ${l.employee} with erp Sign. Open the link, check the document, and sign with a one-time code we'll email you.`, ...(message ? [`Note from the sender: ${message}`] : []), `The link works for ${LINK_DAYS} days.`],
    button: { label: "Review and sign", url: appUrl(tenant.subdomain, `/sign/${r.token}`) },
  });
  await queueEmail(tx, tenant.id, { kind: "esign.request", to: r.email, ...mail });
  await tx`update signature_requests set last_sent_at = now() where id = ${r.id}`;
}

/** Send the current signer a fresh link (the old one stops working). */
export async function resendSignature(tx: Tx, actor: Actor, requestId: string) {
  const [r] = await tx<Req[]>`select ${COLS(tx)} from signature_requests where id = ${requestId} and status = 'pending' for update`;
  if (!r) throw new AppError("not_found", "Nothing is waiting for this signer.");
  const l = await letterOf(tx, r.letter_id);
  await guard(tx, actor, l.employee_id);
  const token = newToken();
  await tx`update signature_requests set token_hash = ${sha256(token)}, otp_hash = null, otp_attempts = 0 where id = ${r.id}`;
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  await sendLink(tx, { id: actor.tenant.id, name: t.name, subdomain: actor.tenant.subdomain }, { id: r.id, token, email: r.signer_email, name: r.signer_name ?? r.signer_email }, l, null);
}

export async function cancelSignatures(tx: Tx, actor: Actor, letterId: string) {
  const l = await letterOf(tx, letterId, true);
  await guard(tx, actor, l.employee_id);
  const r = await tx`update signature_requests set status = 'declined', decline_reason = 'Cancelled by HR', token_hash = null, otp_hash = null where letter_id = ${letterId} and status in ('waiting','pending')`;
  if (!r.count) throw new AppError("conflict", "Nothing is waiting to be signed on this letter.");
  await tx`update generated_letters set status = case when status = 'pending_signature' then 'published' else status end where id = ${letterId}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action) values (${actor.tenant.id}, ${actor.userId}, 'generated_letter', ${letterId}, 'esign.cancel')`;
}

export type SignerRow = { id: string; order: number; name: string; email: string; title: string | null; status: SignerStatus; signed_at: string | null; method: "typed" | "drawn" | null; decline_reason: string | null; last_sent_at: string | null };

export async function signersOf(tx: Tx, letterId: string): Promise<SignerRow[]> {
  // one request = the rows inserted together (same transaction time); the newest request is the one that counts
  const rows = await tx<Req[]>`select ${COLS(tx)} from signature_requests where letter_id = ${letterId}
    and created_at = (select max(created_at) from signature_requests where letter_id = ${letterId}) order by sign_order`;
  return rows.map((r) => ({ id: r.id, order: r.sign_order, name: r.signer_name ?? r.signer_email, email: r.signer_email, title: r.title, status: r.status, signed_at: r.signed_at?.toISOString() ?? null, method: r.signature_type, decline_reason: r.decline_reason, last_sent_at: r.last_sent_at?.toISOString() ?? null }));
}

/** Sign status for a person's letters, keyed by the document's file id (the Documents tab). */
export async function signStatusByFile(tx: Tx, employeeId: string) {
  const rows = await tx<{ file_id: string; letter_id: string; status: string; total: number; signed: number; pending_name: string | null }[]>`
    select g.file_id, g.id as letter_id, g.status,
      (select count(*)::int from signature_requests s where s.letter_id = g.id and s.status in ('waiting','pending','signed')) as total,
      (select count(*)::int from signature_requests s where s.letter_id = g.id and s.status = 'signed') as signed,
      (select coalesce(s.signer_name, s.signer_email::text) from signature_requests s where s.letter_id = g.id and s.status = 'pending' order by s.sign_order limit 1) as pending_name
    from generated_letters g where g.employee_id = ${employeeId} and g.file_id is not null`;
  return Object.fromEntries(rows.map((r) => [r.file_id, { letterId: r.letter_id, status: r.status, total: r.total, signed: r.signed, pendingName: r.pending_name }]));
}

export type TrackingRow = { letter_id: string; doc_type: string; employee_id: string; employee: string; status: string; total: number; signed: number; pending_name: string | null; requested_at: Date; requested_by: string | null };

/** HR: every letter with signatures requested, newest first (in scope). */
export async function signatureTracking(tx: Tx, actor: Actor): Promise<TrackingRow[]> {
  if (!(actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(DOCS))) throw new AppError("forbidden", "You don't have access to do this.");
  const rows = await tx<(TrackingRow & Placement)[]>`
    select g.id as letter_id, coalesce(t.name, 'Letter') as doc_type, e.id as employee_id, e.display_name as employee, g.status,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      (select count(*)::int from signature_requests s where s.letter_id = g.id and s.status in ('waiting','pending','signed')) as total,
      (select count(*)::int from signature_requests s where s.letter_id = g.id and s.status = 'signed') as signed,
      (select coalesce(s.signer_name, s.signer_email::text) from signature_requests s where s.letter_id = g.id and s.status = 'pending' order by s.sign_order limit 1) as pending_name,
      (select max(s.created_at) from signature_requests s where s.letter_id = g.id) as requested_at,
      (select coalesce(ee.display_name, u.email::text) from signature_requests s left join users u on u.id = s.requested_by left join employees ee on ee.user_id = u.id where s.letter_id = g.id order by s.created_at desc limit 1) as requested_by
    from generated_letters g join employees e on e.id = g.employee_id left join letter_templates t on t.id = g.template_id
    where exists (select 1 from signature_requests s where s.letter_id = g.id) order by requested_at desc limit 200`;
  return rows.filter((r) => canManageDocs(actor) || canFor(actor, DOCS, r)).map((r) => ({ letter_id: r.letter_id, doc_type: r.doc_type, employee_id: r.employee_id, employee: r.employee, status: r.status, total: r.total, signed: r.signed, pending_name: r.pending_name, requested_at: r.requested_at, requested_by: r.requested_by }));
}

// ---------- the signer (token link, no sign-in) ----------
async function byToken(tx: Tx, token: string, lock = false): Promise<Req | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const [r] = await tx<Req[]>`select ${COLS(tx)} from signature_requests where token_hash = ${sha256(token)} and created_at > now() - make_interval(days => ${LINK_DAYS}) ${lock ? tx`for update` : tx``}`;
  return r ?? null;
}

export type SignView = {
  company: string; docType: string; employee: string; signer: { name: string; maskedEmail: string; title: string | null; order: number; total: number };
  status: SignerStatus; codeSent: boolean; signedAt: string | null; declineReason: string | null; hash: string;
  others: { name: string; status: SignerStatus; order: number }[]; letterStatus: string;
};

export async function signView(tx: Tx, token: string): Promise<SignView | null> {
  const r = await byToken(tx, token);
  if (!r) return null;
  const l = await letterOf(tx, r.letter_id);
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  const all = await signersOf(tx, r.letter_id);
  return {
    company: t.name, docType: l.doc_type, employee: l.employee,
    signer: { name: r.signer_name ?? r.signer_email, maskedEmail: maskEmail(r.signer_email), title: r.title, order: r.sign_order, total: all.length },
    status: r.status, codeSent: !!r.otp_expires_at && r.otp_expires_at > new Date(), signedAt: r.signed_at?.toISOString() ?? null, declineReason: r.decline_reason, hash: r.document_hash ?? "",
    others: all.map((s) => ({ name: s.name, status: s.status, order: s.order })), letterStatus: l.status,
  };
}

/** The document as it stands (original plus signatures so far) for the signer to read. */
export async function signFile(tx: Tx, token: string) {
  const r = await byToken(tx, token);
  if (!r) return null;
  const l = await letterOf(tx, r.letter_id);
  const [f] = await tx<{ storage_key: string; name: string; mime: string }[]>`select storage_key, name, mime from files where id = ${l.file_id}`;
  return f ?? null;
}

export async function requestSignCode(tx: Tx, tenant: Tenant, token: string) {
  const r = await byToken(tx, token, true);
  if (!r) throw new AppError("invalid", "This link doesn't work any more. Ask the sender for a new one.");
  if (r.status !== "pending") throw new AppError("conflict", r.status === "waiting" ? "It isn't your turn to sign yet. We'll email you when it is." : r.status === "signed" ? "You've already signed this." : "This request was cancelled.");
  if (!canResend(r.last_sent_at, new Date()) && r.otp_hash) throw new AppError("invalid", "A code was sent a moment ago. Check your inbox, or try again in a minute.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await tx`update signature_requests set otp_hash = ${sha256(`${r.id}:${code}`)}, otp_expires_at = now() + make_interval(mins => ${OTP_MINUTES}), otp_attempts = 0, last_sent_at = now() where id = ${r.id}`;
  const l = await letterOf(tx, r.letter_id);
  const mail = simpleEmail({ company: tenant.name, subject: `${code} is your erp Sign code`, heading: `Your code to sign: ${code}`,
    paragraphs: [`Use this code to sign the ${l.doc_type.toLowerCase()} for ${l.employee}. It works for ${OTP_MINUTES} minutes.`, "If you didn't ask for it, you can ignore this email."] });
  await queueEmail(tx, tenant.id, { kind: "esign.code", to: r.signer_email, ...mail });
  return { sentTo: maskEmail(r.signer_email) };
}

export type SignInput = { code: string; method: "typed" | "drawn"; typedName?: string | null; png?: string | null; ip: string | null; userAgent?: string | null };

/** Check the code, record the signature, rebuild the signed PDF, move on to the next signer. */
export async function sign(tx: Tx, tenant: Tenant, token: string, input: SignInput): Promise<{ ok: true; done: boolean } | { ok: false; error: string; field?: string }> {
  const r = await byToken(tx, token, true);
  if (!r) return { ok: false, error: "This link doesn't work any more. Ask the sender for a new one." };
  if (r.status !== "pending") return { ok: false, error: r.status === "signed" ? "You've already signed this." : r.status === "waiting" ? "It isn't your turn to sign yet." : "This request was cancelled." };
  const now = new Date();
  const problem = otpProblem(r, now);
  if (problem) return { ok: false, error: problem, field: "code" };
  const clean = String(input.code ?? "").replace(/\D/g, "");
  const okCode = clean.length === 6 && timingSafeEqual(Buffer.from(sha256(`${r.id}:${clean}`)), Buffer.from(r.otp_hash!));
  if (!okCode) {
    await tx`update signature_requests set otp_attempts = otp_attempts + 1 where id = ${r.id}`;
    const left = Math.max(0, 5 - r.otp_attempts - 1);
    return { ok: false, error: left ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new one.", field: "code" };
  }
  const name = r.signer_name ?? r.signer_email;
  let typedName: string | null = null, png: Uint8Array | null = null;
  if (input.method === "typed") {
    typedName = String(input.typedName ?? "").trim().slice(0, 120);
    if (normName(typedName) !== normName(name)) return { ok: false, error: `Type your name exactly as shown: ${name}.`, field: "typedName" };
  } else {
    png = parsePngDataUrl(input.png);
    if (!png) return { ok: false, error: "Draw your signature in the box first.", field: "png" };
  }
  const l = await letterOf(tx, r.letter_id, true);
  const sigFileId = png ? await saveFile(tx, { tenantId: tenant.id, userId: null, name: safeFileName(`signature - ${name}.png`), mime: "image/png", bytes: png, ext: "png" }) : null;
  await tx`update signature_requests set status = 'signed', signed_at = ${now}, signed_ip = ${input.ip?.slice(0, 64) ?? null}, signature_type = ${input.method}, typed_name = ${typedName},
           signature_file_id = ${sigFileId}, otp_hash = null, token_hash = null where id = ${r.id}`;
  await rebuildSignedPdf(tx, tenant, l);
  const rest = await tx<Req[]>`select ${COLS(tx)} from signature_requests where letter_id = ${l.id} and status in ('waiting','pending','signed') order by sign_order`;
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenant.id}, null, 'signature_request', ${r.id}, 'esign.sign', ${tx.json({ letter_id: l.id, method: input.method, ip: input.ip ?? null, user_agent: input.userAgent?.slice(0, 200) ?? null, hash: r.document_hash })})`;
  const next = nextSigner(rest);
  if (next) {
    const token2 = newToken();
    await tx`update signature_requests set status = 'pending', token_hash = ${sha256(token2)} where id = ${next.id}`;
    await sendLink(tx, { id: tenant.id, name: t.name, subdomain: tenant.subdomain }, { id: next.id, token: token2, email: next.signer_email, name: next.signer_name ?? next.signer_email }, l, null);
    return { ok: true, done: false };
  }
  if (allSigned(rest)) {
    await tx`update generated_letters set status = 'signed' where id = ${l.id}`;
    await notifyEmployee(tx, tenant.id, l.employee_id, "letter.issued", "A signed letter was added to your documents", l.doc_type, `/people/${l.employee_id}`);
    const [req] = await tx<{ employee_id: string | null }[]>`select e.id as employee_id from signature_requests s join employees e on e.user_id = s.requested_by where s.letter_id = ${l.id} order by s.created_at desc limit 1`;
    if (req?.employee_id && req.employee_id !== l.employee_id) await notifyEmployee(tx, tenant.id, req.employee_id, "esign.completed", "Everyone has signed", `${l.doc_type} · ${l.employee}`, `/people/${l.employee_id}?tab=documents`);
    await emitEvent(tx, tenant.id, "letter.signed", { employeeId: l.employee_id, occurrence: l.id, link: `/people/${l.employee_id}?tab=documents`, vars: { "letter.title": l.doc_type } });   // Settings → Automations
  }
  return { ok: true, done: true };
}

/** Original + a signature page for every signature so far → a new file; the letter and its Documents entry point at it. */
async function rebuildSignedPdf(tx: Tx, tenant: Tenant, l: Letter) {
  const originalId = l.original_file_id ?? l.file_id;
  const original = await fileBytes(tx, originalId);
  const signed = await tx<Req[]>`select ${COLS(tx)} from signature_requests where letter_id = ${l.id} and status = 'signed' order by sign_order`;
  const blocks: SignatureBlock[] = [];
  for (const s of signed) {
    let png: Uint8Array | null = null;
    if (s.signature_file_id) { const [f] = await tx<{ storage_key: string }[]>`select storage_key from files where id = ${s.signature_file_id}`; png = f ? await storage().get(f.storage_key) : null; }
    blocks.push({ name: s.signer_name ?? s.signer_email, title: s.title, method: s.signature_type ?? "typed", typedName: s.typed_name, png,
      audit: auditLine({ signedAt: s.signed_at ?? new Date(), ip: s.signed_ip, method: s.signature_type ?? "typed", email: maskEmail(s.signer_email) }), hash: s.document_hash ?? "" });
  }
  const [t] = await tx<{ name: string }[]>`select name from tenants`;
  const bytes = await appendSignaturePage(original, blocks, { company: t.name, title: `${l.doc_type} · ${l.employee}` });
  const [orig] = await tx<{ name: string }[]>`select name from files where id = ${originalId}`;
  const fileId = await saveFile(tx, { tenantId: tenant.id, userId: null, name: safeFileName(orig.name.replace(/( \(signed\))?\.pdf$/i, "") + " (signed).pdf"), mime: "application/pdf", bytes, ext: "pdf" });
  const previous = l.file_id;
  await tx`update generated_letters set file_id = ${fileId}, original_file_id = ${originalId} where id = ${l.id}`;
  await tx`update employee_documents set file_id = ${fileId} where file_id = ${previous} and employee_id = ${l.employee_id}`;
  if (previous !== originalId) await tx`delete from files where id = ${previous} and not exists (select 1 from employee_documents where file_id = ${previous}) and not exists (select 1 from generated_letters where file_id = ${previous} or original_file_id = ${previous})`;
}

export async function declineSignature(tx: Tx, tenant: Tenant, token: string, reason: string) {
  const r = await byToken(tx, token, true);
  if (!r) throw new AppError("invalid", "This link doesn't work any more.");
  if (r.status !== "pending") throw new AppError("conflict", "There's nothing waiting for your signature.");
  const why = reason.trim().slice(0, 500) || null;
  await tx`update signature_requests set status = 'declined', decline_reason = ${why}, token_hash = null, otp_hash = null where id = ${r.id}`;
  await tx`update signature_requests set status = 'declined', decline_reason = ${`Stopped: ${r.signer_name ?? r.signer_email} declined`}, token_hash = null where letter_id = ${r.letter_id} and status = 'waiting'`;
  const l = await letterOf(tx, r.letter_id, true);
  await tx`update generated_letters set status = case when status = 'pending_signature' then 'published' else status end where id = ${l.id}`;
  const [req] = await tx<{ employee_id: string }[]>`select e.id as employee_id from employees e join users u on u.id = e.user_id where u.id = ${r.requested_by}`;
  if (req) await notifyEmployee(tx, tenant.id, req.employee_id, "esign.declined", `${r.signer_name ?? r.signer_email} declined to sign`, `${l.doc_type} · ${l.employee}${why ? ` · ${why}` : ""}`, `/people/${l.employee_id}?tab=documents`);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenant.id}, null, 'signature_request', ${r.id}, 'esign.decline', ${tx.json({ reason: why })})`;
}
