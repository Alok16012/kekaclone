import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { queueEmail } from "@/server/email";
import { storage } from "@/server/storage";
import { ERASED_NAME, erasedEmail, erasureBlocker, retentionCutoff } from "@/server/modules/assist/rules";
import { assertCandidateSee, canAdminHire } from "./access";
import { hireSettings } from "./assist";
import { candidateMail } from "./mail";
import { audit } from "./setup";
import { findToken } from "./tokens";

/**
 * Candidate privacy (DPDP Act / GDPR style): a candidate can ask, from their portal, for their details to be removed;
 * hiring admins can do it on request; and a company can set a retention period after which inactive candidates are
 * anonymised by the daily job. Removing keeps the shape of the hiring history (counts, stages, dates) but drops
 * everything that identifies the person: name, contact details, resume, notes, documents, letters and email copies.
 * Active applications are withdrawn (there's no one left to hire).
 *
 * Stored files are deleted from storage only after the database change commits (the caller gets their keys).
 */

async function blockerFor(tx: Tx, candidateId: string, lock = true) {
  const [c] = await tx<{ employee_id: string | null; anonymised_at: Date | null; live: boolean; active: number }[]>`
    select c.employee_id, c.anonymised_at,
      exists (select 1 from offers o join applications a on a.id = o.application_id where a.candidate_id = c.id and o.status in ('pending_approval','released','accepted')) as live,
      (select count(*)::int from applications a where a.candidate_id = c.id and a.status = 'active') as active
    from candidates c where c.id = ${candidateId} ${lock ? tx`for update` : tx``}`;
  if (!c) return { missing: true as const };
  return { missing: false as const, reason: erasureBlocker({ employeeId: c.employee_id, anonymised: !!c.anonymised_at, liveOffer: c.live, activeApplications: c.active }) };
}

/** For the profile's "remove personal data" dialog: why it can't be done now, if anything (no lock). */
export async function erasureBlockerFor(tx: Tx, candidateId: string) {
  const b = await blockerFor(tx, candidateId, false);
  return b.missing ? "Candidate not found." : b.reason;
}

/**
 * Removes the candidate's personal data in place. Returns the storage keys of files that were deleted, to remove from
 * storage after commit. Guarded: an employee, a live offer or an already-removed record is refused.
 */
export async function anonymiseCandidate(tx: Tx, tenantId: string, candidateId: string, by: { userId: string | null; source: "portal" | "hr" | "retention" }) {
  const b = await blockerFor(tx, candidateId);
  if (b.missing) throw new AppError("not_found", "Candidate not found.");
  if (b.reason) throw new AppError("conflict", b.reason);
  const [c] = await tx<{ email: string; resume_file_id: string | null }[]>`select email::text, resume_file_id from candidates where id = ${candidateId}`;
  const fileRows = await tx<{ id: string }[]>`
    select ${c.resume_file_id}::uuid as id where ${c.resume_file_id}::uuid is not null
    union select file_id from document_requests where candidate_id = ${candidateId} and file_id is not null
    union select file_id from generated_letters where candidate_id = ${candidateId} and file_id is not null
    union select g.file_id from generated_letters g join offers o on o.letter_id = g.id join applications a on a.id = o.application_id where a.candidate_id = ${candidateId} and g.file_id is not null`;
  const apps = (await tx<{ id: string }[]>`select id from applications where candidate_id = ${candidateId}`).map((a) => a.id);

  await tx`update candidates set first_name = ${ERASED_NAME}, last_name = null, email = ${erasedEmail(candidateId)}, mobile = null, gender = null, current_company = null,
             current_title = null, experience_months = null, resume_file_id = null, parsed = '{}', tags = '{}', custom = '{}', consent_at = null, anonymised_at = now()
           where id = ${candidateId}`;
  await tx`delete from candidate_notes where candidate_id = ${candidateId}`;
  await tx`delete from document_requests where candidate_id = ${candidateId}`;
  await tx`delete from preboarding_tasks where candidate_id = ${candidateId}`;
  await tx`delete from hire_tokens where candidate_id = ${candidateId}`;
  await tx`update referrals set note = null where candidate_id = ${candidateId}`;
  if (apps.length) {
    await tx`delete from resume_scores where application_id = any(${apps}::uuid[])`;
    await tx`update applications set answers = '{}', reject_reason = null, status = case when status = 'active' then 'withdrawn' else status end where id = any(${apps}::uuid[])`;
    await tx`update application_events set data = jsonb_build_object('removed', true) where application_id = any(${apps}::uuid[]) and kind not in ('stage_change','hired')`;
    await tx`update scorecard_submissions set comments = null where application_id = any(${apps}::uuid[])`;
    await tx`update offers set signed_name = null, signed_ip = null, decline_reason = null, note = null, otp_hash = null where application_id = any(${apps}::uuid[])`;
    await tx`delete from generated_letters where id in (select o.letter_id from offers o where o.application_id = any(${apps}::uuid[]) and o.letter_id is not null)`;
    await tx`update interviews set notes = null where application_id = any(${apps}::uuid[])`;
  }
  await tx`delete from generated_letters where candidate_id = ${candidateId}`;
  // copies of emails sent to them (anything still queued is dropped too)
  await tx`update outbound_emails set to_email = ${erasedEmail(candidateId)}, subject = '[removed]', html = '', text_body = '', status = case when status = 'queued' then 'failed' else status end
           where to_email = ${c.email}::citext`;
  await tx`update candidate_privacy_requests set reason = null where candidate_id = ${candidateId}`;

  const keys: string[] = [];
  for (const f of fileRows) {
    const gone = await tx.savepoint(async (sp) => {
      const [r] = await sp<{ storage_key: string }[]>`delete from files where id = ${f.id} returning storage_key`;
      return r?.storage_key ?? null;
    }).catch(() => null);   // still used somewhere else (e.g. copied to an employee record): keep it
    if (gone) keys.push(gone);
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenantId}, ${by.userId}, 'candidate', ${candidateId}, 'candidate.anonymised', ${tx.json({ source: by.source, files: keys.length, applications: apps.length })})`;
  return { keys };
}

/** Deletes file bytes after the database change committed. Failures are logged, never thrown. */
export async function removeBlobs(keys: string[]) {
  for (const k of keys) await storage().remove(k).catch((e) => console.error("remove blob", k, e));
}

// ---------------------------------------------------------------- candidate portal: "delete my data"
export type PortalErasure = { outcome: "removed" | "pending" | "declined"; message: string; keys: string[] };

/**
 * The candidate asks for their details to be removed. When nothing stops it, it happens at once and a confirmation is
 * emailed first; with an offer out, the request waits for the hiring team; employees are told why it can't be done here.
 * Asking twice while a request waits is a no-op.
 */
export async function requestErasureFromPortal(tx: Tx, token: string, input: { confirm: boolean; reason: string | null }): Promise<PortalErasure> {
  if (!input.confirm) throw new AppError("invalid", "Tick the box to confirm.", "confirm");
  const t = await findToken(tx, "portal", token, { allowUsed: true });
  if (!t?.candidate_id) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const candidateId = t.candidate_id;
  const [tenant] = await tx<{ id: string; name: string }[]>`select id, name from tenants`;
  const [c] = await tx<{ first_name: string; email: string }[]>`select first_name, email::text from candidates where id = ${candidateId}`;
  const reason = input.reason?.trim().slice(0, 500) || null;
  const b = await blockerFor(tx, candidateId);
  if (b.missing) throw new AppError("invalid", "This link has expired. Ask the hiring team for a new one.");
  const [pending] = await tx<{ id: string }[]>`select id from candidate_privacy_requests where candidate_id = ${candidateId} and status = 'pending'`;
  if (pending) return { outcome: "pending", message: "Your request is already with the hiring team. We'll email you when it's done.", keys: [] };

  if (b.reason) {
    const employee = /employee/.test(b.reason);
    await tx`insert into candidate_privacy_requests (tenant_id, candidate_id, source, status, reason, decided_at, decision_note)
             values (${tenant.id}, ${candidateId}, 'portal', ${employee ? "declined" : "pending"}, ${reason}, ${employee ? new Date() : null}, ${employee ? b.reason : null})`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${tenant.id}, null, 'candidate', ${candidateId}, 'candidate.erasure_requested', ${tx.json({ outcome: employee ? "declined" : "pending" })})`;
    if (employee) return { outcome: "declined", message: "You're now an employee, so your details are kept as part of your employment records. Ask HR if you have questions.", keys: [] };
    const admins = await hiringAdmins(tx);
    for (const id of admins) await notifyEmployee(tx, tenant.id, id, "hire.erasure_request", "A candidate asked for their data to be removed", "There's an offer out for them, so it needs your decision.", "/settings/hire?tab=privacy");
    return { outcome: "pending", message: "There's an offer out for you, so the hiring team will finish this. We'll email you when it's done.", keys: [] };
  }
  // remove first (that also blanks earlier email copies), then queue the confirmation to the address they had
  const { keys } = await anonymiseCandidate(tx, tenant.id, candidateId, { userId: null, source: "portal" });
  await tx`insert into candidate_privacy_requests (tenant_id, candidate_id, source, status, decided_at, decision_note) values (${tenant.id}, ${candidateId}, 'portal', 'completed', now(), 'Removed at once')`;
  const mail = candidateMail(tenant.name, `Your details were removed from ${tenant.name}'s hiring records`,
    `Hi ${c.first_name},\n\nAs you asked, we've removed your name, contact details, resume and documents from ${tenant.name}'s hiring records. Links we sent you earlier no longer work.\n\nIf you apply again in future, you'll start fresh.`);
  await queueEmail(tx, tenant.id, { kind: "hire.erasure_done", to: c.email, ...mail });
  return { outcome: "removed", message: "Your details have been removed. We've emailed you a confirmation.", keys };
}

async function hiringAdmins(tx: Tx) {
  const rows = await tx<{ id: string }[]>`
    select distinct ra.employee_id as id from role_assignments ra join roles r on r.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where ('hire.admin' = any(r.permissions) or '*' = any(r.permissions)) and jsonb_array_length(ra.scopes) = 0`;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- hiring admins
const assertPrivacyAdmin = (actor: Actor) => {
  if (!canAdminHire(actor)) throw new AppError("forbidden", "Only hiring admins for the whole company can remove candidate data.");
};

/** HR removes a candidate's data on their request (e.g. by email). Company-wide hiring admins only; never their own record. */
export async function eraseCandidateByHr(tx: Tx, actor: Actor, candidateId: string, note: string | null) {
  assertPrivacyAdmin(actor);
  await assertCandidateSee(tx, actor, candidateId);
  const [c] = await tx<{ first_name: string; email: string }[]>`select first_name, email::text from candidates where id = ${candidateId}`;
  const { keys } = await anonymiseCandidate(tx, actor.tenant.id, candidateId, { userId: actor.userId, source: "hr" });
  const n = note?.trim().slice(0, 500) || null;
  const [p] = await tx<{ id: string }[]>`update candidate_privacy_requests set status = 'completed', decided_by = ${actor.userId}, decided_at = now(), decision_note = ${n} where candidate_id = ${candidateId} and status = 'pending' returning id`;
  if (!p) await tx`insert into candidate_privacy_requests (tenant_id, candidate_id, source, status, decided_by, decided_at, decision_note) values (${actor.tenant.id}, ${candidateId}, 'hr', 'completed', ${actor.userId}, now(), ${n})`;
  const mail = candidateMail(actor.tenant.name, `Your details were removed from ${actor.tenant.name}'s hiring records`,
    `Hi ${c.first_name},\n\nWe've removed your name, contact details, resume and documents from ${actor.tenant.name}'s hiring records. Links we sent you earlier no longer work.`);
  await queueEmail(tx, actor.tenant.id, { kind: "hire.erasure_done", to: c.email, ...mail });
  await audit(tx, actor, actor.tenant.id, "candidate", candidateId, "candidate.erasure_by_hr", { note: !!n });
  return { keys };
}

/** Decline a waiting request (e.g. a legal hold), with a reason the candidate is emailed. */
export async function declinePrivacyRequest(tx: Tx, actor: Actor, requestId: string, note: string) {
  assertPrivacyAdmin(actor);
  const n = note.trim().slice(0, 500);
  if (!n) throw new AppError("invalid", "Say why, so the candidate knows.", "note");
  const [r] = await tx<{ candidate_id: string | null }[]>`
    update candidate_privacy_requests set status = 'declined', decided_by = ${actor.userId}, decided_at = now(), decision_note = ${n} where id = ${requestId} and status = 'pending' returning candidate_id`;
  if (!r) throw new AppError("not_found", "This request was already handled.");
  const [c] = await tx<{ first_name: string; email: string }[]>`select first_name, email::text from candidates where id = ${r.candidate_id}`;
  if (c) await queueEmail(tx, actor.tenant.id, { kind: "hire.erasure_declined", to: c.email, ...candidateMail(actor.tenant.name, `About your request to remove your details`, `Hi ${c.first_name},\n\nWe couldn't remove your details yet: ${n}\n\nReply to this email if you have questions.`) });
  await audit(tx, actor, actor.tenant.id, "candidate_privacy_request", requestId, "decline", { note: n });
}

export type PrivacyRow = { id: string; candidate_id: string | null; candidate: string; source: string; status: string; reason: string | null; decision_note: string | null; created_at: Date; decided_at: Date | null; decided_by: string | null; blocker: string | null };

export async function privacyRequests(tx: Tx, actor: Actor): Promise<PrivacyRow[]> {
  assertPrivacyAdmin(actor);
  const rows = await tx<(Omit<PrivacyRow, "blocker">)[]>`
    select r.id, r.candidate_id, coalesce(trim(c.first_name || ' ' || coalesce(c.last_name, '')), 'Deleted record') as candidate, r.source, r.status, r.reason, r.decision_note,
      r.created_at, r.decided_at, e.display_name as decided_by
    from candidate_privacy_requests r left join candidates c on c.id = r.candidate_id left join users u on u.id = r.decided_by left join employees e on e.user_id = u.id
    order by r.status = 'pending' desc, r.created_at desc limit 100`;
  const out: PrivacyRow[] = [];
  for (const r of rows) {
    let blocker: string | null = null;
    if (r.status === "pending" && r.candidate_id) { const b = await blockerFor(tx, r.candidate_id, false); blocker = b.missing ? null : b.reason; }
    out.push({ ...r, blocker });
  }
  return out;
}

// ---------------------------------------------------------------- retention (daily job)
/**
 * Anonymises candidates with no hiring activity since the retention cutoff: not employees, no active application,
 * no live offer, not already removed. At most `limit` per run (the next run continues). Runs its own transactions
 * so file bytes are removed only after each commit.
 */
export async function retentionSweep(tenantId: string, today: string, limit = 200) {
  const due = await withTenant(tenantId, async (tx) => {
    const s = await hireSettings(tx);
    if (!s.candidate_retention_months) return [];
    const cutoff = retentionCutoff(today, s.candidate_retention_months);
    return tx<{ id: string }[]>`
      select c.id from candidates c
      where c.anonymised_at is null and c.employee_id is null
        and not exists (select 1 from applications a where a.candidate_id = c.id and a.status = 'active')
        and greatest(c.created_at, c.updated_at,
              coalesce((select max(a.updated_at) from applications a where a.candidate_id = c.id), c.created_at),
              coalesce((select max(ev.created_at) from application_events ev join applications a on a.id = ev.application_id where a.candidate_id = c.id), c.created_at)
            ) < ${cutoff}::date
      order by c.created_at limit ${limit}`;
  });
  let removed = 0, skipped = 0;
  for (const c of due) {
    try {
      const { keys } = await withTenant(tenantId, async (tx) => {
        const r = await anonymiseCandidate(tx, tenantId, c.id, { userId: null, source: "retention" });
        await tx`insert into candidate_privacy_requests (tenant_id, candidate_id, source, status, decided_at, decision_note) values (${tenantId}, ${c.id}, 'retention', 'completed', now(), 'Retention period passed')`;
        return r;
      });
      await removeBlobs(keys);
      removed++;
    } catch (e) { if (e instanceof AppError) skipped++; else throw e; }
  }
  return { removed, skipped };
}
