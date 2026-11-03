import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { accessTo } from "@/server/modules/employees/profile";
import { encryptField, decryptField } from "@/server/modules/payroll/secret";
import { todayIn } from "@/lib/dates";
import { ID_KINDS, ID_LABELS, maskId, normaliseIdNumber, type IdKind } from "./rules";

/**
 * Family (with nominees), education, experience and identity documents on a profile.
 * The person and HR (employees.write in scope) edit; managers see family/education/experience but never ID numbers.
 * ID numbers are encrypted (AES-GCM bound to tenant + person + kind); only HR can reveal one, and every reveal is audited.
 */

const date = z.iso.date().nullable().optional();
const txt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export const relationInput = z.object({
  relation: z.enum(["father", "mother", "spouse", "child", "sibling", "other"]),
  name: z.string().trim().min(1, "Enter a name").max(120),
  gender: z.enum(["male", "female", "non_binary", "undisclosed"]).nullable().optional(),
  dob: date, email: txt(160), mobile: txt(20), profession: txt(80), isNominee: z.boolean().optional(),
});
export const educationInput = z.object({
  degree: z.string().trim().min(1, "Enter the degree or course").max(120), branch: txt(120), institution: txt(160), score: txt(20),
  startYear: z.number().int().min(1950).max(2100).nullable().optional(), endYear: z.number().int().min(1950).max(2100).nullable().optional(),
}).refine((v) => !v.startYear || !v.endYear || v.endYear >= v.startYear, { message: "The end year is before the start.", path: ["endYear"] });
export const experienceInput = z.object({
  company: z.string().trim().min(1, "Enter the company").max(160), title: txt(120), location: txt(120), description: txt(1000),
  startDate: date, endDate: date,
}).refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: "The end date is before the start.", path: ["endDate"] });
export const identityInput = z.object({
  kind: z.enum(ID_KINDS), number: z.string().max(40), nameOnDoc: txt(120), expiryDate: date,
});

export type SectionKind = "relation" | "education" | "experience";
const TABLES: Record<SectionKind, string> = { relation: "employee_relations", education: "employee_educations", experience: "employee_experiences" };

async function placement(tx: Tx, employeeId: string) {
  const [p] = await tx<(Placement & { status: string })[]>`select department_id, location_id, legal_entity_id, business_unit_id, status from employees where id = ${employeeId}`;
  if (!p) throw new AppError("not_found", "That person isn't in your company.");
  return p;
}

async function assertEdit(tx: Tx, actor: Actor, employeeId: string) {
  await placement(tx, employeeId);
  const a = await accessTo(tx, actor, employeeId);
  if (a !== "admin" && a !== "self") throw new AppError("forbidden", "You can't edit this profile.");
  return a;
}

export type ProfileSections = {
  canEdit: boolean; isAdmin: boolean;
  relations: { id: string; relation: string; name: string; gender: string | null; dob: string | null; email: string | null; mobile: string | null; profession: string | null; is_nominee: boolean }[];
  educations: { id: string; degree: string; branch: string | null; institution: string | null; score: string | null; start_year: number | null; end_year: number | null }[];
  experiences: { id: string; company: string; title: string | null; location: string | null; description: string | null; start_date: string | null; end_date: string | null }[];
  identities: { id: string; kind: IdKind; label: string; masked: string; name_on_doc: string | null; expiry_date: string | null; verified: boolean; verified_at: string | null; verified_by: string | null; expired: boolean }[] | null;
};

/** null for colleagues (they see none of this). */
export async function profileSections(tx: Tx, actor: Actor, employeeId: string): Promise<ProfileSections | null> {
  const a = await accessTo(tx, actor, employeeId);
  if (a === "colleague") return null;
  const today = todayIn();
  const [relations, educations, experiences, ids] = await Promise.all([
    tx<ProfileSections["relations"]>`select id, relation, name, gender, dob::text, email, mobile, profession, is_nominee from employee_relations where employee_id = ${employeeId} order by is_nominee desc, created_at`,
    tx<ProfileSections["educations"]>`select id, degree, branch, institution, score, start_year, end_year from employee_educations where employee_id = ${employeeId} order by end_year desc nulls first, created_at`,
    tx<ProfileSections["experiences"]>`select id, company, title, location, description, start_date::text, end_date::text from employee_experiences where employee_id = ${employeeId} order by start_date desc nulls last, created_at`,
    a === "manager" ? Promise.resolve([]) : tx<{ id: string; kind: IdKind; number_last4: string | null; name_on_doc: string | null; expiry_date: string | null; verified_at: Date | null; verified_by: string | null }[]>`
      select i.id, i.kind, i.number_last4, i.name_on_doc, i.expiry_date::text, i.verified_at, v.display_name as verified_by
      from employee_identities i left join employees v on v.user_id = i.verified_by where i.employee_id = ${employeeId} order by i.kind`,
  ]);
  return {
    canEdit: a === "admin" || a === "self", isAdmin: a === "admin", relations, educations, experiences,
    identities: a === "manager" ? null : ids.map((i) => ({ id: i.id, kind: i.kind, label: ID_LABELS[i.kind], masked: maskId(i.kind, i.number_last4), name_on_doc: i.name_on_doc,
      expiry_date: i.expiry_date, verified: !!i.verified_at, verified_at: i.verified_at?.toISOString() ?? null, verified_by: i.verified_by, expired: !!i.expiry_date && i.expiry_date < today })),
  };
}

export async function saveSectionRow(tx: Tx, actor: Actor, employeeId: string, kind: SectionKind, id: string | null, raw: unknown) {
  await assertEdit(tx, actor, employeeId);
  let row: Record<string, unknown>;
  if (kind === "relation") {
    const p = relationInput.safeParse(raw);
    if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
    const v = p.data;
    row = { relation: v.relation, name: v.name, gender: v.gender ?? null, dob: v.dob ?? null, email: v.email, mobile: v.mobile, profession: v.profession, is_nominee: !!v.isNominee };
  } else if (kind === "education") {
    const p = educationInput.safeParse(raw);
    if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
    const v = p.data;
    row = { degree: v.degree, branch: v.branch, institution: v.institution, score: v.score, start_year: v.startYear ?? null, end_year: v.endYear ?? null };
  } else {
    const p = experienceInput.safeParse(raw);
    if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
    const v = p.data;
    if (v.startDate && v.startDate > todayIn()) throw new AppError("invalid", "Past experience can't start in the future.", "startDate");
    row = { company: v.company, title: v.title, location: v.location, description: v.description, start_date: v.startDate ?? null, end_date: v.endDate ?? null };
  }
  const table = TABLES[kind];
  if (id) {
    const [r] = await tx<{ id: string }[]>`update ${tx(table)} set ${tx(row as never)} where id = ${id} and employee_id = ${employeeId} returning id`;
    if (!r) throw new AppError("not_found", "That entry was removed.");
  } else {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)} where employee_id = ${employeeId}`;
    if (n >= 30) throw new AppError("invalid", "That's the most entries a profile can hold here.");
    const [r] = await tx<{ id: string }[]>`insert into ${tx(table)} ${tx({ tenant_id: actor.tenant.id, employee_id: employeeId, ...row } as never)} returning id`;
    id = r.id;
  }
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: `${kind}.save`, diff: { id, ...row } });
  return { id };
}

export async function deleteSectionRow(tx: Tx, actor: Actor, employeeId: string, kind: SectionKind, id: string) {
  await assertEdit(tx, actor, employeeId);
  const [r] = await tx<{ id: string }[]>`delete from ${tx(TABLES[kind])} where id = ${id} and employee_id = ${employeeId} returning id`;
  if (!r) throw new AppError("not_found", "That entry was already removed.");
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: `${kind}.delete`, diff: { id } });
}

const scope = (tenantId: string, employeeId: string, kind: string) => [tenantId, employeeId, `identity:${kind}`];

/**
 * Add or replace one ID of a kind. A verified ID is locked for the person (HR changes it, which clears verification:
 * a changed number has to be checked again). Duplicate PAN/Aadhaar inside the company is refused.
 */
export async function saveIdentity(tx: Tx, actor: Actor, employeeId: string, raw: unknown) {
  const access = await assertEdit(tx, actor, employeeId);
  const p = identityInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const n = normaliseIdNumber(v.kind, v.number);
  if (!n.ok) throw new AppError("invalid", n.error, "number");
  const [cur] = await tx<{ id: string; verified_at: Date | null }[]>`select id, verified_at from employee_identities where employee_id = ${employeeId} and kind = ${v.kind}`;
  if (cur?.verified_at && access !== "admin") throw new AppError("forbidden", `Your ${ID_LABELS[v.kind]} is verified. Ask HR to change it.`, "number");
  if (v.kind === "pan" || v.kind === "aadhaar") {
    // last-4 narrows the candidates; decrypting them confirms an exact duplicate without storing a searchable hash
    const others = await tx<{ employee_id: string; number_enc: Uint8Array }[]>`select employee_id, number_enc from employee_identities where kind = ${v.kind} and number_last4 = ${n.value.slice(-4)} and employee_id <> ${employeeId}`;
    for (const o of others) {
      let same = false;
      try { same = decryptField(o.number_enc, scope(actor.tenant.id, o.employee_id, v.kind)) === n.value; } catch { /* unreadable row: ignore */ }
      if (same) throw new AppError("conflict", `Another person in your company already has this ${ID_LABELS[v.kind]}.`, "number");
    }
  }
  const enc = encryptField(n.value, scope(actor.tenant.id, employeeId, v.kind));
  const row = { number_enc: enc, number_last4: n.value.slice(-4), name_on_doc: v.nameOnDoc, expiry_date: v.expiryDate ?? null, verified_at: null, verified_by: null };
  let id: string;
  if (cur) { await tx`update employee_identities set ${tx(row as never)} where id = ${cur.id}`; id = cur.id; }
  else id = (await tx<{ id: string }[]>`insert into employee_identities ${tx({ tenant_id: actor.tenant.id, employee_id: employeeId, kind: v.kind, ...row } as never)} returning id`)[0].id;
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: "identity.save", diff: { kind: v.kind, last4: n.value.slice(-4), replaced: !!cur } });
  return { id };
}

/** HR marks an ID as checked against the document. Nobody verifies their own. */
export async function verifyIdentity(tx: Tx, actor: Actor, identityId: string, verified: boolean) {
  const [i] = await tx<{ employee_id: string; kind: IdKind }[]>`select employee_id, kind from employee_identities where id = ${identityId}`;
  if (!i) throw new AppError("not_found", "That ID was removed.");
  const p = await placement(tx, i.employee_id);
  if (!canFor(actor, "employees.write", p)) throw new AppError("forbidden", "Only HR can verify IDs.");
  if (i.employee_id === actor.employeeId) throw new AppError("forbidden", "Someone else in HR has to verify your own ID.");
  await tx`update employee_identities set verified_at = ${verified ? new Date() : null}, verified_by = ${verified ? actor.userId : null} where id = ${identityId}`;
  await audit(tx, actor, { entityType: "employee", entityId: i.employee_id, action: verified ? "identity.verify" : "identity.unverify", diff: { kind: i.kind } });
}

/** Full number for HR, audited. The person sees their own masked number only (they have the card). */
export async function revealIdentity(tx: Tx, actor: Actor, identityId: string) {
  const [i] = await tx<{ employee_id: string; kind: IdKind; number_enc: Uint8Array }[]>`select employee_id, kind, number_enc from employee_identities where id = ${identityId}`;
  if (!i) throw new AppError("not_found", "That ID was removed.");
  const p = await placement(tx, i.employee_id);
  if (!canFor(actor, "employees.write", p)) throw new AppError("forbidden", "Only HR can see full ID numbers.");
  const number = decryptField(i.number_enc, scope(actor.tenant.id, i.employee_id, i.kind));
  await audit(tx, actor, { entityType: "employee", entityId: i.employee_id, action: "identity.reveal", diff: { kind: i.kind } });
  return { number };
}

export async function deleteIdentity(tx: Tx, actor: Actor, identityId: string) {
  const [i] = await tx<{ employee_id: string; kind: IdKind; verified_at: Date | null }[]>`select employee_id, kind, verified_at from employee_identities where id = ${identityId}`;
  if (!i) throw new AppError("not_found", "That ID was already removed.");
  const access = await assertEdit(tx, actor, i.employee_id);
  if (i.verified_at && access !== "admin") throw new AppError("forbidden", "A verified ID can only be removed by HR.");
  await tx`delete from employee_identities where id = ${identityId}`;
  await audit(tx, actor, { entityType: "employee", entityId: i.employee_id, action: "identity.delete", diff: { kind: i.kind } });
}
