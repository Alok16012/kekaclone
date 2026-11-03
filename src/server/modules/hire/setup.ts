import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { sanitizeHtml } from "@/server/modules/documents/rules";
import { assertHireAdmin } from "./access";
import {
  DEFAULT_EMAIL_TEMPLATES, DEFAULT_FLOW, DEFAULT_JD_TEMPLATES, DEFAULT_OFFER_TEMPLATE, DEFAULT_SCALE, DEFAULT_SCORECARD, EMAIL_PLACEHOLDERS,
  EMAIL_TEMPLATE_KEYS, OFFER_PLACEHOLDERS, STAGE_GROUPS, textToHtml, unknownIn, validateFlow, validateScale, validateSections,
  type ScalePoint, type Section, type StageGroup,
} from "./rules";

export async function audit(tx: Tx, actor: Actor | null, tenantId: string, entity: string, id: string | null, action: string, diff: Record<string, unknown> = {}) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenantId}, ${actor?.userId ?? null}, ${entity}, ${id}, ${action}, ${tx.json(diff as never)})`;
}

const uniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

/** Default flow, scale, scorecard, email and JD templates, an offer letter and the careers page. Safe to run again. */
export async function ensureHireDefaults(tx: Tx, tenantId: string) {
  const [flow] = await tx<{ id: string }[]>`
    insert into hiring_flows (tenant_id, name, description, is_default) values (${tenantId}, 'Standard', 'Screening, two interview rounds, offer', true)
    on conflict (tenant_id, name) do nothing returning id`;
  if (flow) for (const [i, s] of DEFAULT_FLOW.entries()) {
    await tx`insert into hiring_stages (tenant_id, flow_id, name, stage_group, position, on_enter_email_key)
             values (${tenantId}, ${flow.id}, ${s.name}, ${s.group}, ${i}, null)`;
  }
  const [scale] = await tx<{ id: string }[]>`
    insert into rating_scales (tenant_id, name, usage, points) values (${tenantId}, '5-point scale', 'hire', ${tx.json(DEFAULT_SCALE as never)})
    on conflict (tenant_id, name) do update set name = excluded.name returning id`;
  await tx`insert into scorecards (tenant_id, name, rating_scale_id, sections, overall_rating)
           values (${tenantId}, 'General interview', ${scale.id}, ${tx.json(DEFAULT_SCORECARD as never)}, false) on conflict (tenant_id, name) do nothing`;
  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    await tx`insert into email_templates (tenant_id, module, key, subject, body_html) values (${tenantId}, 'hire', ${t.key}, ${t.subject}, ${t.body})
             on conflict (tenant_id, module, key) do nothing`;
  }
  for (const t of DEFAULT_JD_TEMPLATES) {
    await tx`insert into jd_templates (tenant_id, name, description_html) values (${tenantId}, ${t.name}, ${textToHtml(t.text.replace(/^- /gm, "• "))}) on conflict (tenant_id, name) do nothing`;
  }
  await tx`insert into letter_templates (tenant_id, name, kind, body_html, candidate_signature) values (${tenantId}, ${DEFAULT_OFFER_TEMPLATE.name}, 'offer', ${DEFAULT_OFFER_TEMPLATE.body}, true)
           on conflict (tenant_id, name) do nothing`;
  const [t] = await tx<{ subdomain: string; name: string }[]>`select subdomain, name from tenants where id = ${tenantId}`;
  if (t) await tx`insert into career_sites (tenant_id, slug, title, about_html) values (${tenantId}, ${t.subdomain}, ${`Careers at ${t.name}`}, ${textToHtml(`We're growing. Have a look at the roles below and apply in a few minutes.`)})
                  on conflict (slug) do nothing`;
  await tx`insert into roles (tenant_id, key, name, is_system, permissions)
           select ${tenantId}, 'recruiter', 'Recruiter', true, ${["hire.recruit"]}::text[] where not exists (select 1 from roles where key = 'recruiter')`;
}

// ---------- hiring flows ----------
export type FlowStage = { id: string; name: string; stage_group: StageGroup; position: number; on_enter_email_key: string | null; in_use: number };
export type FlowRow = { id: string; name: string; description: string | null; is_default: boolean; jobs: number; stages: FlowStage[] };

export async function listFlows(tx: Tx): Promise<FlowRow[]> {
  const flows = await tx<Omit<FlowRow, "stages">[]>`
    select f.id, f.name, f.description, f.is_default, (select count(*)::int from jobs j where j.hiring_flow_id = f.id) as jobs
    from hiring_flows f order by f.is_default desc, f.name`;
  const stages = await tx<(FlowStage & { flow_id: string })[]>`
    select s.id, s.flow_id, s.name, s.stage_group, s.position, s.on_enter_email_key,
      (select count(*)::int from applications a where a.stage_id = s.id) as in_use
    from hiring_stages s order by s.position`;
  return flows.map((f) => ({ ...f, stages: stages.filter((s) => s.flow_id === f.id) }));
}

export type FlowInput = { name: string; description?: string | null; isDefault: boolean; stages: { id?: string | null; name: string; group: string; onEnterEmailKey?: string | null }[] };

export async function saveFlow(tx: Tx, actor: Actor, id: string | null, input: FlowInput) {
  assertHireAdmin(actor);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new AppError("invalid", "Give the flow a name.", "name");
  const stages = input.stages.map((s) => ({ ...s, name: s.name.trim(), onEnterEmailKey: s.onEnterEmailKey || null }));
  const problem = validateFlow(stages);
  if (problem) throw new AppError("invalid", problem, "stages");
  if (stages.some((s) => s.onEnterEmailKey && !EMAIL_TEMPLATE_KEYS.some((k) => k.key === s.onEnterEmailKey))) throw new AppError("invalid", "Pick one of the email templates.", "stages");
  let flowId = id;
  const [same] = await tx`select 1 from hiring_flows where lower(name) = lower(${name}) and id is distinct from ${id}`;
  if (same) throw new AppError("conflict", "A flow with this name already exists.", "name");
  try {
    await tx.savepoint(async (sp) => {
      if (id) {
        const [f] = await sp<{ id: string }[]>`update hiring_flows set name = ${name}, description = ${input.description?.trim() || null} where id = ${id} returning id`;
        if (!f) throw new AppError("not_found", "Flow not found.");
      } else {
        const [f] = await sp<{ id: string }[]>`insert into hiring_flows (tenant_id, name, description) values (${actor.tenant.id}, ${name}, ${input.description?.trim() || null}) returning id`;
        flowId = f.id;
      }
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A flow with this name already exists.", "name");
    throw e;
  }
  const existing = await tx<{ id: string; stage_group: string; in_use: number }[]>`
    select s.id, s.stage_group, (select count(*)::int from applications a where a.stage_id = s.id) as in_use from hiring_stages s where s.flow_id = ${flowId}`;
  const keep = new Set(stages.map((s) => s.id).filter(Boolean) as string[]);
  for (const s of stages) if (s.id && !existing.some((e) => e.id === s.id)) throw new AppError("invalid", "One of the stages isn't part of this flow.", "stages");
  for (const e of existing) {
    const next = stages.find((s) => s.id === e.id);
    if (!keep.has(e.id) && e.in_use) throw new AppError("conflict", "A stage that still has candidates can't be removed. Move them first.", "stages");
    if (next && e.in_use && next.group !== e.stage_group) throw new AppError("conflict", `"${next.name}" has candidates, so its group can't change.`, "stages");
  }
  await tx`delete from hiring_stages where flow_id = ${flowId} and not (id = any(${[...keep]}::uuid[]))`;
  // positions are unique per flow (checked at commit), so shift them out of the way first
  await tx`update hiring_stages set position = position + 1000 where flow_id = ${flowId}`;
  for (const [i, s] of stages.entries()) {
    if (s.id) await tx`update hiring_stages set name = ${s.name}, stage_group = ${s.group}, position = ${i}, on_enter_email_key = ${s.onEnterEmailKey} where id = ${s.id}`;
    else await tx`insert into hiring_stages (tenant_id, flow_id, name, stage_group, position, on_enter_email_key) values (${actor.tenant.id}, ${flowId}, ${s.name}, ${s.group}, ${i}, ${s.onEnterEmailKey})`;
  }
  if (input.isDefault) {
    await tx`update hiring_flows set is_default = false where is_default and id <> ${flowId}`;
    await tx`update hiring_flows set is_default = true where id = ${flowId}`;
  }
  await audit(tx, actor, actor.tenant.id, "hiring_flow", flowId, id ? "update" : "create", { name, stages: stages.map((s) => `${s.name} (${s.group})`) });
  return { id: flowId! };
}

export async function deleteFlow(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const [f] = await tx<{ is_default: boolean; jobs: number }[]>`select is_default, (select count(*)::int from jobs where hiring_flow_id = ${id}) as jobs from hiring_flows where id = ${id}`;
  if (!f) throw new AppError("not_found", "Flow not found.");
  if (f.jobs) throw new AppError("conflict", "Jobs use this flow, so it can't be deleted.");
  if (f.is_default) throw new AppError("conflict", "Make another flow the default first.");
  await tx`delete from hiring_flows where id = ${id}`;
  await audit(tx, actor, actor.tenant.id, "hiring_flow", id, "delete");
}

// ---------- rating scales and scorecards ----------
export type ScaleRow = { id: string; name: string; points: ScalePoint[]; used: number };
export type ScorecardRow = { id: string; name: string; rating_scale_id: string; sections: Section[]; overall_rating: boolean; used: number };

export async function listScorecards(tx: Tx) {
  const [scales, cards] = await Promise.all([
    tx<ScaleRow[]>`select s.id, s.name, s.points, (select count(*)::int from scorecards c where c.rating_scale_id = s.id) as used from rating_scales s where s.usage in ('hire','any') order by s.name`,
    tx<ScorecardRow[]>`select c.id, c.name, c.rating_scale_id, c.sections, c.overall_rating, (select count(*)::int from scorecard_submissions x where x.scorecard_id = c.id) as used from scorecards c order by c.name`,
  ]);
  return { scales, cards };
}

export async function saveScale(tx: Tx, actor: Actor, id: string | null, input: { name: string; points: ScalePoint[] }) {
  assertHireAdmin(actor);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new AppError("invalid", "Give the scale a name.", "name");
  const points = input.points.map((p) => ({ value: Number(p.value), label: String(p.label ?? "").trim() })).sort((a, b) => a.value - b.value);
  const problem = validateScale(points);
  if (problem) throw new AppError("invalid", problem, "points");
  if (id) {
    const [used] = await tx<{ n: number }[]>`select count(*)::int as n from scorecard_submissions x join scorecards c on c.id = x.scorecard_id where c.rating_scale_id = ${id}`;
    const [old] = await tx<{ points: ScalePoint[] }[]>`select points from rating_scales where id = ${id}`;
    if (!old) throw new AppError("not_found", "Scale not found.");
    if (used.n && JSON.stringify(old.points.map((p) => p.value).sort()) !== JSON.stringify(points.map((p) => p.value).sort())) {
      throw new AppError("conflict", "Interviewers have already scored with this scale. You can rename the points, but not change their values.", "points");
    }
  }
  try {
    return await tx.savepoint(async (sp) => {
      const [r] = id
        ? await sp<{ id: string }[]>`update rating_scales set name = ${name}, points = ${sp.json(points as never)} where id = ${id} returning id`
        : await sp<{ id: string }[]>`insert into rating_scales (tenant_id, name, usage, points) values (${actor.tenant.id}, ${name}, 'hire', ${sp.json(points as never)}) returning id`;
      await audit(sp, actor, actor.tenant.id, "rating_scale", r.id, id ? "update" : "create", { name, points });
      return r;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A scale with this name already exists.", "name");
    throw e;
  }
}

export async function deleteScale(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const [u] = await tx<{ n: number }[]>`select count(*)::int as n from scorecards where rating_scale_id = ${id}`;
  if (u.n) throw new AppError("conflict", "Scorecards use this scale. Change them first.");
  const r = await tx`delete from rating_scales where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Scale not found.");
  await audit(tx, actor, actor.tenant.id, "rating_scale", id, "delete");
}

const slug = (s: string, i: number) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "c") + (i ? `_${i}` : "");

export async function saveScorecard(tx: Tx, actor: Actor, id: string | null, input: { name: string; ratingScaleId: string; overallRating: boolean; sections: { title: string; criteria: { id?: string | null; label: string }[] }[] }) {
  assertHireAdmin(actor);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new AppError("invalid", "Give the scorecard a name.", "name");
  const [scale] = await tx`select 1 from rating_scales where id = ${input.ratingScaleId}`;
  if (!scale) throw new AppError("invalid", "Pick a rating scale.", "ratingScaleId");
  const used = new Set<string>();
  const sections: Section[] = input.sections.map((s) => ({
    title: s.title.trim(),
    criteria: s.criteria.map((c) => {
      let cid = c.id && /^[a-z0-9_-]{1,40}$/i.test(c.id) && !used.has(c.id) ? c.id : "";
      for (let i = 0; !cid; i++) { const k = slug(c.label, i); if (!used.has(k)) cid = k; }
      used.add(cid);
      return { id: cid, label: c.label.trim() };
    }),
  }));
  const problem = validateSections(sections);
  if (problem) throw new AppError("invalid", problem, "sections");
  try {
    return await tx.savepoint(async (sp) => {
      const [r] = id
        ? await sp<{ id: string }[]>`update scorecards set name = ${name}, rating_scale_id = ${input.ratingScaleId}, overall_rating = ${input.overallRating}, sections = ${sp.json(sections as never)} where id = ${id} returning id`
        : await sp<{ id: string }[]>`insert into scorecards (tenant_id, name, rating_scale_id, overall_rating, sections) values (${actor.tenant.id}, ${name}, ${input.ratingScaleId}, ${input.overallRating}, ${sp.json(sections as never)}) returning id`;
      if (!r) throw new AppError("not_found", "Scorecard not found.");
      await audit(sp, actor, actor.tenant.id, "scorecard", r.id, id ? "update" : "create", { name });
      return r;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A scorecard with this name already exists.", "name");
    throw e;
  }
}

export async function deleteScorecard(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const [u] = await tx<{ n: number }[]>`select count(*)::int as n from scorecard_submissions where scorecard_id = ${id}`;
  if (u.n) throw new AppError("conflict", "Interviewers have submitted this scorecard, so it's kept for their feedback.");
  const r = await tx`delete from scorecards where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Scorecard not found.");
  await audit(tx, actor, actor.tenant.id, "scorecard", id, "delete");
}

// ---------- JD, email and offer templates ----------
export type JdTemplate = { id: string; name: string; description_html: string };
export const listJdTemplates = (tx: Tx) => tx<JdTemplate[]>`select id, name, description_html from jd_templates order by name`;

export async function saveJdTemplate(tx: Tx, actor: Actor, id: string | null, input: { name: string; html: string }) {
  assertHireAdmin(actor);
  const name = input.name.trim().slice(0, 80);
  const html = sanitizeHtml(input.html ?? "");
  if (!name) throw new AppError("invalid", "Give the template a name.", "name");
  if (!html.replace(/<[^>]+>/g, "").trim()) throw new AppError("invalid", "Write the job description.", "html");
  try {
    return await tx.savepoint(async (sp) => {
      const [r] = id
        ? await sp<{ id: string }[]>`update jd_templates set name = ${name}, description_html = ${html} where id = ${id} returning id`
        : await sp<{ id: string }[]>`insert into jd_templates (tenant_id, name, description_html) values (${actor.tenant.id}, ${name}, ${html}) returning id`;
      if (!r) throw new AppError("not_found", "Template not found.");
      await audit(sp, actor, actor.tenant.id, "jd_template", r.id, id ? "update" : "create", { name });
      return r;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A template with this name already exists.", "name");
    throw e;
  }
}

export async function deleteJdTemplate(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const r = await tx`delete from jd_templates where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Template not found.");
  await audit(tx, actor, actor.tenant.id, "jd_template", id, "delete");
}

export type EmailTemplate = { key: string; label: string; subject: string; body: string };
export async function listEmailTemplates(tx: Tx): Promise<EmailTemplate[]> {
  const rows = await tx<{ key: string; subject: string; body_html: string }[]>`select key, subject, body_html from email_templates where module = 'hire'`;
  return EMAIL_TEMPLATE_KEYS.map((k) => {
    const r = rows.find((x) => x.key === k.key), d = DEFAULT_EMAIL_TEMPLATES.find((x) => x.key === k.key)!;
    return { key: k.key, label: k.label, subject: r?.subject ?? d.subject, body: r?.body_html ?? d.body };
  });
}

export async function saveEmailTemplate(tx: Tx, actor: Actor, key: string, input: { subject: string; body: string }) {
  assertHireAdmin(actor);
  if (!EMAIL_TEMPLATE_KEYS.some((k) => k.key === key)) throw new AppError("not_found", "Template not found.");
  const subject = input.subject.trim().slice(0, 200), body = input.body.trim().slice(0, 5000);
  if (!subject) throw new AppError("invalid", "Write a subject.", "subject");
  if (!body) throw new AppError("invalid", "Write the email.", "body");
  const unknown = unknownIn(subject + " " + body, EMAIL_PLACEHOLDERS);
  if (unknown.length) throw new AppError("invalid", `Unknown placeholder: ${unknown.map((u) => `{{${u}}}`).join(", ")}.`, "body");
  await tx`insert into email_templates (tenant_id, module, key, subject, body_html) values (${actor.tenant.id}, 'hire', ${key}, ${subject}, ${body})
           on conflict (tenant_id, module, key) do update set subject = excluded.subject, body_html = excluded.body_html`;
  await audit(tx, actor, actor.tenant.id, "email_template", null, "hire.update", { key });
}

export type OfferTemplate = { id: string; name: string; body_html: string; used: number };
export const listOfferTemplates = (tx: Tx) =>
  tx<OfferTemplate[]>`select t.id, t.name, t.body_html, (select count(*)::int from offers o where o.template_id = t.id) as used from letter_templates t where t.kind = 'offer' order by t.name`;

export async function saveOfferTemplate(tx: Tx, actor: Actor, id: string | null, input: { name: string; html: string }) {
  assertHireAdmin(actor);
  const name = input.name.trim().slice(0, 120);
  const html = sanitizeHtml(input.html ?? "");
  if (!name) throw new AppError("invalid", "Give the template a name.", "name");
  if (!html.replace(/<[^>]+>/g, "").trim()) throw new AppError("invalid", "The letter is empty.", "html");
  const unknown = unknownIn(html, OFFER_PLACEHOLDERS);
  if (unknown.length) throw new AppError("invalid", `Unknown placeholder: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use the Insert field menu.`, "html");
  try {
    return await tx.savepoint(async (sp) => {
      const [r] = id
        ? await sp<{ id: string }[]>`update letter_templates set name = ${name}, body_html = ${html} where id = ${id} and kind = 'offer' returning id`
        : await sp<{ id: string }[]>`insert into letter_templates (tenant_id, name, kind, body_html, candidate_signature) values (${actor.tenant.id}, ${name}, 'offer', ${html}, true) returning id`;
      if (!r) throw new AppError("not_found", "Template not found.");
      await audit(sp, actor, actor.tenant.id, "letter_template", r.id, id ? "offer.update" : "offer.create", { name });
      return r;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A letter template with this name already exists.", "name");
    throw e;
  }
}

export async function deleteOfferTemplate(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const r = await tx`delete from letter_templates where id = ${id} and kind = 'offer'`;   // offers keep their letter (template_id set null)
  if (!r.count) throw new AppError("not_found", "Template not found.");
  await audit(tx, actor, actor.tenant.id, "letter_template", id, "offer.delete");
}

// ---------- careers page ----------
export type CareerSite = { id: string; slug: string; title: string; about_html: string | null; branding: { color?: string; tagline?: string } };
export async function careerSite(tx: Tx): Promise<CareerSite | null> {
  const [s] = await tx<CareerSite[]>`select id, slug::text, title, about_html, branding from career_sites order by created_at limit 1`;
  return s ?? null;
}

export async function saveCareerSite(tx: Tx, actor: Actor, input: { title: string; about: string; tagline: string }) {
  assertHireAdmin(actor);
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new AppError("invalid", "Give the page a title.", "title");
  const about = textToHtml(input.about.slice(0, 4000));
  const branding = { tagline: input.tagline.trim().slice(0, 160) || undefined };
  const [s] = await tx<{ id: string }[]>`update career_sites set title = ${title}, about_html = ${about}, branding = ${tx.json(branding as never)} returning id`;
  if (!s) await tx`insert into career_sites (tenant_id, slug, title, about_html, branding) values (${actor.tenant.id}, ${actor.tenant.subdomain}, ${title}, ${about}, ${tx.json(branding as never)})`;
  await audit(tx, actor, actor.tenant.id, "career_site", s?.id ?? null, "update", { title });
}

// ---------- approval chains (requisitions and offers) ----------
export type ChainLevel = { approver: "manager" | "l2_manager" | "role" | "employee"; role?: string; id?: string };
export const CHAIN_ENTITIES = ["requisition", "offer"] as const;
export type ChainEntity = (typeof CHAIN_ENTITIES)[number];

export async function approvalChains(tx: Tx) {
  const rows = await tx<{ entity_type: ChainEntity; levels: ChainLevel[] }[]>`
    select distinct on (entity_type) entity_type, levels from approval_workflows where entity_type in ('requisition','offer') and is_active order by entity_type, priority desc, created_at desc`;
  const roles = await tx<{ key: string; name: string }[]>`select key, name from roles order by name`;
  return { requisition: rows.find((r) => r.entity_type === "requisition")?.levels ?? null, offer: rows.find((r) => r.entity_type === "offer")?.levels ?? null, roles };
}

/** Saves the chain for requisitions or offers. [] = use the built-in default again. */
export async function saveApprovalChain(tx: Tx, actor: Actor, entity: ChainEntity, levels: ChainLevel[]) {
  assertHireAdmin(actor);
  if (!CHAIN_ENTITIES.includes(entity)) throw new AppError("not_found", "Unknown approval chain.");
  if (levels.length > 5) throw new AppError("invalid", "Use at most 5 approval levels.", "levels");
  const clean: ChainLevel[] = [];
  for (const l of levels) {
    if (l.approver === "manager" || l.approver === "l2_manager") clean.push({ approver: l.approver });
    else if (l.approver === "role") {
      const [r] = await tx`select 1 from roles where key = ${l.role ?? ""}`;
      if (!r) throw new AppError("invalid", "Pick a role for every role level.", "levels");
      clean.push({ approver: "role", role: l.role });
    } else if (l.approver === "employee") {
      const [e] = await tx`select 1 from employees where id = ${l.id ?? null} and status <> 'relieved'`;
      if (!e) throw new AppError("invalid", "Pick a person for every named level.", "levels");
      clean.push({ approver: "employee", id: l.id });
    } else throw new AppError("invalid", "Pick who approves each level.", "levels");
  }
  await tx`update approval_workflows set is_active = false where entity_type = ${entity}`;
  if (clean.length) await tx`insert into approval_workflows (tenant_id, entity_type, name, levels, priority) values (${actor.tenant.id}, ${entity}, ${entity === "requisition" ? "Requisitions" : "Offers"}, ${tx.json(clean as never)}, 10)`;
  await audit(tx, actor, actor.tenant.id, "approval_workflow", null, `${entity}.update`, { levels: clean });
}

// ---------- candidate custom fields ----------
export type FieldDef = { id: string; key: string; label: string; type: "text" | "number" | "date" | "select"; options: string[] | null; required: boolean; position: number };
export const FIELD_TYPES = [{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "select", label: "Pick from a list" }] as const;

export const candidateFields = (tx: Tx) =>
  tx<FieldDef[]>`select id, key, label, type, options, required, position from custom_field_defs where entity = 'candidate' and status = 'published' order by position, label`;

export async function saveCandidateField(tx: Tx, actor: Actor, id: string | null, input: { label: string; type: string; options: string[]; required: boolean }) {
  assertHireAdmin(actor);
  const label = input.label.trim().slice(0, 60);
  if (!label) throw new AppError("invalid", "Give the field a name.", "label");
  if (!FIELD_TYPES.some((t) => t.value === input.type)) throw new AppError("invalid", "Pick a field type.", "type");
  const options = input.type === "select" ? [...new Set(input.options.map((o) => o.trim()).filter(Boolean))].slice(0, 30) : null;
  if (input.type === "select" && (options?.length ?? 0) < 2) throw new AppError("invalid", "Add at least two choices.", "options");
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";
  try {
    return await tx.savepoint(async (sp) => {
      const [r] = id
        ? await sp<{ id: string }[]>`update custom_field_defs set label = ${label}, type = ${input.type}, options = ${options ? sp.json(options) : null}, required = ${input.required} where id = ${id} and entity = 'candidate' returning id`
        : await sp<{ id: string }[]>`insert into custom_field_defs (tenant_id, entity, section, key, label, type, options, required, status, position)
            values (${actor.tenant.id}, 'candidate', 'hire', ${key}, ${label}, ${input.type}, ${options ? sp.json(options) : null}, ${input.required}, 'published',
              (select coalesce(max(position), 0) + 1 from custom_field_defs where entity = 'candidate')) returning id`;
      if (!r) throw new AppError("not_found", "Field not found.");
      await audit(sp, actor, actor.tenant.id, "custom_field", r.id, id ? "candidate.update" : "candidate.create", { label });
      return r;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new AppError("conflict", "A field with this name already exists.", "label");
    throw e;
  }
}

export async function deleteCandidateField(tx: Tx, actor: Actor, id: string) {
  assertHireAdmin(actor);
  const r = await tx`update custom_field_defs set status = 'archived', key = key || '_' || substr(md5(random()::text), 1, 6) where id = ${id} and entity = 'candidate' and status = 'published'`;
  if (!r.count) throw new AppError("not_found", "Field not found.");
  await audit(tx, actor, actor.tenant.id, "custom_field", id, "candidate.archive");
}

/** Validates custom values against the published fields; unknown keys are dropped. */
export function cleanCustom(defs: FieldDef[], raw: Record<string, unknown>, opts: { partial?: boolean } = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const d of defs) {
    const v = raw?.[d.key];
    const s = v == null ? "" : String(v).trim();
    if (!s) { if (d.required && !opts.partial) throw new AppError("invalid", `${d.label} is required.`, `custom.${d.key}`); continue; }
    if (d.type === "number") { const n = Number(s); if (!Number.isFinite(n)) throw new AppError("invalid", `${d.label} must be a number.`, `custom.${d.key}`); out[d.key] = n; }
    else if (d.type === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AppError("invalid", `${d.label} must be a date.`, `custom.${d.key}`); out[d.key] = s; }
    else if (d.type === "select") { if (!d.options?.includes(s)) throw new AppError("invalid", `Pick one of the choices for ${d.label}.`, `custom.${d.key}`); out[d.key] = s; }
    else out[d.key] = s.slice(0, 500);
  }
  return out;
}

export const STAGE_GROUP_OPTIONS = STAGE_GROUPS;
