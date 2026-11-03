import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { accessTo } from "@/server/modules/employees/profile";
import { EVERYWHERE } from "./approvals-admin";
import {
  CUSTOM_FIELD_TYPES, FIELD_ROLES, canEditField, canViewField, coerceFieldValue, fieldRoleFor, slugKey,
  type CustomFieldDef, type CustomFieldType, type FieldRole, type FieldValue,
} from "./rules";

/** Field definitions describe the company's own profile schema: an unscoped settings.org grant manages them. */
export const canManageFields = (actor: Actor) => canFor(actor, "settings.org", EVERYWHERE);
const assertManage = (actor: Actor) => { if (!canManageFields(actor)) throw new AppError("forbidden", "You don't have access to custom fields."); };

const COLS = (tx: Tx) => tx`id, key, label, section, type, options, required, view_roles, edit_roles, position, status`;

export async function listDefs(tx: Tx, opts: { published?: boolean } = {}) {
  return tx<CustomFieldDef[]>`select ${COLS(tx)} from custom_field_defs where entity = 'employee' and status <> 'archived'
    and (${!opts.published} or status = 'published') order by section, position, label`;
}

export type DefInput = { label: string; section: string; type: string; options?: string[] | null; required: boolean; viewRoles: string[]; editRoles: string[]; position?: number };

function clean(input: DefInput) {
  const label = input.label.trim(), section = input.section.trim();
  if (!label || label.length > 80) throw new AppError("invalid", "Give the field a label (up to 80 characters).", "label");
  if (!section || section.length > 60) throw new AppError("invalid", "Choose or type a section (up to 60 characters).", "section");
  if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(input.type)) throw new AppError("invalid", "Choose a field type.", "type");
  const type = input.type as CustomFieldType;
  let options: string[] | null = null;
  if (type === "select" || type === "multi_select") {
    options = [...new Set((input.options ?? []).map((o) => o.trim()).filter(Boolean))];
    if (options.length < 2) throw new AppError("invalid", "Add at least two options.", "options");
    if (options.length > 50 || options.some((o) => o.length > 60)) throw new AppError("invalid", "Use up to 50 options of up to 60 characters.", "options");
  }
  const roles = (xs: string[]) => [...new Set(xs.filter((r): r is FieldRole => (FIELD_ROLES as readonly string[]).includes(r)).concat("hr_admin"))];
  const editRoles = roles(input.editRoles);
  const viewRoles = [...new Set(roles(input.viewRoles).concat(editRoles))];   // editing implies seeing
  return { label, section, type, options, required: !!input.required, view_roles: viewRoles, edit_roles: editRoles, position: Math.max(0, Math.min(999, Math.trunc(input.position ?? 0))) };
}

export async function saveDef(tx: Tx, actor: Actor, id: string | null, input: DefInput) {
  assertManage(actor);
  const v = clean(input);
  if (id) {
    const [cur] = await tx<CustomFieldDef[]>`select ${COLS(tx)} from custom_field_defs where id = ${id} and entity = 'employee'`;
    if (!cur) throw new AppError("not_found", "That field was deleted.");
    if (cur.status !== "draft" && cur.type !== v.type) throw new AppError("invalid", "A published field keeps its type. Archive it and create a new one instead.", "type");
    if (cur.status !== "draft" && cur.options && v.options) {
      const removed = cur.options.filter((o) => !v.options!.includes(o));
      if (removed.length) {
        const [used] = await tx`select 1 from employees where custom ? ${cur.key} and (custom->>${cur.key} = any(${removed}) or (jsonb_typeof(custom->${cur.key}) = 'array' and custom->${cur.key} ?| ${removed}))`;
        if (used) throw new AppError("conflict", `Some people have “${removed[0]}” as their answer. Keep the option, or change their answers first.`, "options");
      }
    }
    await tx`update custom_field_defs set ${tx(v as never)} where id = ${id}`;
    await audit(tx, actor, { entityType: "custom_field", entityId: id, action: "update", diff: { before: { label: cur.label, section: cur.section, required: cur.required, view: cur.view_roles, edit: cur.edit_roles }, after: { label: v.label, section: v.section, required: v.required, view: v.view_roles, edit: v.edit_roles } } });
    return { id };
  }
  let key = slugKey(v.label);
  for (let i = 2; (await tx`select 1 from custom_field_defs where entity = 'employee' and key = ${key}`).length; i++) key = `${slugKey(v.label).slice(0, 36)}_${i}`;
  const [r] = await tx<{ id: string }[]>`insert into custom_field_defs ${tx({ tenant_id: actor.tenant.id, entity: "employee", key, ...v, status: "draft" } as never)} returning id`;
  await audit(tx, actor, { entityType: "custom_field", entityId: r.id, action: "create", diff: { key, label: v.label, type: v.type, section: v.section } });
  return { id: r.id, key };
}

/** draft → published (shown on profiles, the add wizard and the import template) → archived (hidden, values kept). */
export async function setDefStatus(tx: Tx, actor: Actor, id: string, status: "published" | "archived" | "draft") {
  assertManage(actor);
  const [cur] = await tx<{ status: string; label: string }[]>`select status, label from custom_field_defs where id = ${id} and entity = 'employee'`;
  if (!cur) throw new AppError("not_found", "That field was deleted.");
  const allowed: Record<string, string[]> = { draft: ["published"], published: ["archived"], archived: ["published"] };
  if (!allowed[cur.status]?.includes(status)) throw new AppError("invalid", `A ${cur.status} field can't be moved to ${status}.`);
  await tx`update custom_field_defs set status = ${status} where id = ${id}`;
  await audit(tx, actor, { entityType: "custom_field", entityId: id, action: status === "published" ? "publish" : "archive", diff: { label: cur.label } });
}

export async function deleteDef(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const [d] = await tx<{ label: string }[]>`delete from custom_field_defs where id = ${id} and entity = 'employee' and status = 'draft' returning label`;
  if (!d) throw new AppError("invalid", "Only draft fields can be deleted. Archive a published field instead.");
  await audit(tx, actor, { entityType: "custom_field", entityId: id, action: "delete", diff: d });
}

/**
 * Validates submitted values against published definitions for a role. Unknown keys and fields the role can't edit
 * are refused; with `requireAll` every required field must have a value (the add wizard and imports).
 */
export function checkValues(defs: CustomFieldDef[], role: FieldRole, raw: Record<string, unknown>, opts: { requireAll?: boolean; current?: Record<string, unknown> } = {}) {
  const out: Record<string, FieldValue> = {};
  const errors: { key: string; error: string }[] = [];
  for (const k of Object.keys(raw)) {
    const d = defs.find((x) => x.key === k && x.status === "published");
    if (!d) { errors.push({ key: k, error: "This field isn't available." }); continue; }
    if (!canEditField(d, role)) { errors.push({ key: k, error: `You can't change ${d.label}.` }); continue; }
    const r = coerceFieldValue(d, raw[k]);
    if (!r.ok) errors.push({ key: k, error: r.error }); else out[k] = r.value;
  }
  if (opts.requireAll) {
    for (const d of defs) if (d.status === "published" && d.required && !(d.key in raw) && (opts.current?.[d.key] == null)) errors.push({ key: d.key, error: `${d.label} is required.` });
  }
  return { values: out, errors };
}

export type PersonField = { key: string; label: string; section: string; type: CustomFieldType; options: string[] | null; required: boolean; value: FieldValue; canEdit: boolean };

/** Published fields the viewer may see on this profile, with values. Colleagues see none. */
export async function personFields(tx: Tx, actor: Actor, employeeId: string): Promise<PersonField[]> {
  const role = fieldRoleFor(await accessTo(tx, actor, employeeId));
  if (!role) return [];
  const [defs, [e]] = await Promise.all([listDefs(tx, { published: true }), tx<{ custom: Record<string, FieldValue> }[]>`select custom from employees where id = ${employeeId}`]);
  return defs.filter((d) => canViewField(d, role)).map((d) => ({
    key: d.key, label: d.label, section: d.section, type: d.type, options: d.options, required: d.required, value: e?.custom?.[d.key] ?? null, canEdit: canEditField(d, role),
  }));
}

/** Saves edited values (merge into employees.custom). Directly applied for every role allowed to edit the field. */
export async function savePersonFields(tx: Tx, actor: Actor, employeeId: string, raw: Record<string, unknown>) {
  const role = fieldRoleFor(await accessTo(tx, actor, employeeId));
  if (!role) throw new AppError("forbidden", "You can't edit this profile.");
  const defs = await listDefs(tx, { published: true });
  const { values, errors } = checkValues(defs, role, raw);
  if (errors.length) throw new AppError("invalid", errors[0].error, errors[0].key);
  if (!Object.keys(values).length) return { changed: 0 };
  const [cur] = await tx<{ custom: Record<string, FieldValue> }[]>`select custom from employees where id = ${employeeId}`;
  const changed = Object.keys(values).filter((k) => JSON.stringify(cur.custom?.[k] ?? null) !== JSON.stringify(values[k]));
  if (!changed.length) return { changed: 0 };
  const next = { ...(cur.custom ?? {}) };
  for (const k of changed) { if (values[k] == null) delete next[k]; else next[k] = values[k]; }
  await tx`update employees set custom = ${tx.json(next as never)} where id = ${employeeId}`;
  const labels = changed.map((k) => defs.find((d) => d.key === k)!.label);
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${actor.tenant.id}, ${employeeId}, 'profile_updated', current_date, ${tx.json({ fields: labels })}, ${actor.userId})`;
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: "custom_fields.update", diff: Object.fromEntries(changed.map((k) => [k, { old: cur.custom?.[k] ?? null, new: values[k] }])) });
  return { changed: changed.length };
}
