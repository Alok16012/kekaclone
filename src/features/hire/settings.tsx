"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, CalendarCheck, Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { EmployeePicker } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { EMAIL_PLACEHOLDERS, EMAIL_TEMPLATE_KEYS, groupLabel, htmlToText, OFFER_PLACEHOLDERS, STAGE_GROUPS } from "@/server/modules/hire/rules";
import type { ChainLevel, EmailTemplate, FieldDef, FlowRow, JdTemplate, OfferTemplate, ScaleRow, ScorecardRow, CareerSite } from "@/server/modules/hire/setup";
import {
  deleteFieldAction, deleteFlowAction, deleteJdTemplateAction, deleteOfferTemplateAction, deleteScaleAction, deleteScorecardAction, saveCareerSiteAction, saveChainAction,
  saveEmailTemplateAction, saveFieldAction, saveFlowAction, saveJdTemplateAction, saveOfferTemplateAction, saveScaleAction, saveScorecardAction,
} from "@/app/(app)/hire/actions";
import { RichText, StageBadge } from "./shared";

type Props = {
  canEdit: boolean; flows: FlowRow[]; cards: { scales: ScaleRow[]; cards: ScorecardRow[] }; jds: JdTemplate[]; emails: EmailTemplate[]; offers: OfferTemplate[];
  site: CareerSite | null; chains: { requisition: ChainLevel[] | null; offer: ChainLevel[] | null; roles: { key: string; name: string }[] }; fields: FieldDef[];
  people: { id: string; name: string; title: string | null }[]; subdomain: string; calendar: { configured: boolean; provider: string | null; missing: string[] }; initialTab: string;
};
type Res = { ok: boolean; error?: string; field?: string };
const done = (r: Res, msg: string, after?: () => void) => { if (r.ok) { toast.success(msg); after?.(); } else toast.error(r.error ?? "Couldn't save."); };

/** S148–S151: hiring flows, scorecards and scales, JD / email / offer templates, careers page, approval chains, candidate fields, integrations. */
export function HireSettings(p: Props) {
  const [tab, setTab] = React.useState(p.initialTab);
  return (
    <div className="flex flex-col gap-4">
      {!p.canEdit && <Banner tone="info" title="View only">Only hiring admins for the whole company can change hiring settings.</Banner>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[{ value: "flows", label: "Hiring flows" }, { value: "scorecards", label: "Scorecards" }, { value: "templates", label: "Templates" }, { value: "careers", label: "Careers page" },
          { value: "approvals", label: "Approvals" }, { value: "fields", label: "Candidate fields" }, { value: "integrations", label: "Integrations" }]} />
        <TabsContent value="flows"><Flows {...p} /></TabsContent>
        <TabsContent value="scorecards"><Scorecards {...p} /></TabsContent>
        <TabsContent value="templates"><Templates {...p} /></TabsContent>
        <TabsContent value="careers"><Careers {...p} /></TabsContent>
        <TabsContent value="approvals"><Approvals {...p} /></TabsContent>
        <TabsContent value="fields"><Fields {...p} /></TabsContent>
        <TabsContent value="integrations"><Integrations {...p} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- flows ----------
function Flows({ flows, canEdit }: Props) {
  const [editing, setEditing] = React.useState<FlowRow | "new" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {canEdit && <Button className="self-start" variant="secondary" onClick={() => setEditing("new")}><Plus />New flow</Button>}
      {flows.map((f) => (
        <Card key={f.id}>
          <CardHeader title={<span className="inline-flex items-center gap-2">{f.name}{f.is_default && <Badge tone="accent">Default</Badge>}</span>} description={`${f.description ?? ""}${f.description ? " · " : ""}used by ${f.jobs} ${f.jobs === 1 ? "job" : "jobs"}`}
            action={canEdit ? <div className="flex gap-1"><IconButton size="icon-sm" label={`Edit ${f.name}`} onClick={() => setEditing(f)}><Pencil /></IconButton>
              {!f.jobs && !f.is_default && <ConfirmDialog title={`Delete ${f.name}?`} description="This can't be undone." confirmLabel="Delete" onConfirm={async () => done(await deleteFlowAction(f.id), "Flow deleted")} trigger={<IconButton size="icon-sm" label={`Delete ${f.name}`}><Trash2 /></IconButton>} />}</div> : undefined} />
          <CardBody><ol className="flex flex-wrap items-center gap-2">{f.stages.map((s, i) => <li key={s.id} className="flex items-center gap-2">{i > 0 && <span aria-hidden className="text-text-muted">→</span>}<StageBadge group={s.stage_group} label={s.name} />{s.in_use > 0 && <span className="text-xs text-text-muted tabular">{s.in_use}</span>}</li>)}</ol></CardBody>
        </Card>
      ))}
      {editing && <FlowDialog flow={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function FlowDialog({ flow, onClose }: { flow: FlowRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(flow?.name ?? "");
  const [desc, setDesc] = React.useState(flow?.description ?? "");
  const [isDefault, setIsDefault] = React.useState(flow?.is_default ?? false);
  const [stages, setStages] = React.useState(flow?.stages.map((s) => ({ id: s.id as string | null, name: s.name, group: s.stage_group as string, onEnterEmailKey: s.on_enter_email_key, inUse: s.in_use }))
    ?? [{ id: null, name: "New", group: "sourced", onEnterEmailKey: null, inUse: 0 }, { id: null, name: "Interview", group: "interview", onEnterEmailKey: null, inUse: 0 }, { id: null, name: "Offer", group: "offer", onEnterEmailKey: null, inUse: 0 }, { id: null, name: "Hired", group: "hired", onEnterEmailKey: null, inUse: 0 }, { id: null, name: "Not selected", group: "rejected", onEnterEmailKey: null, inUse: 0 }]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const upd = (i: number, k: "name" | "group" | "onEnterEmailKey", v: string | null) => setStages((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const swap = (i: number, j: number) => setStages((s) => { const n = [...s]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={flow ? `Edit ${flow.name}` : "New hiring flow"} description="Stages run in group order: Sourced, Screening, Interview, Offer, Hired, then Rejected."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => {
        setError(null);
        const r = await saveFlowAction(flow?.id ?? null, { name, description: desc || null, isDefault, stages: stages.map((s) => ({ id: s.id, name: s.name, group: s.group, onEnterEmailKey: s.onEnterEmailKey || null })) });
        if (!r.ok) setError(r.error); else { toast.success("Flow saved"); onClose(); }
      })}>Save flow</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} /></Field>
        </div>
        <Switch checked={isDefault} onCheckedChange={(c) => setIsDefault(!!c)} label="Use for new jobs by default" />
        <ol className="flex flex-col gap-2">
          {stages.map((s, i) => (
            <li key={s.id ?? `n${i}`} className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-center">
              <span className="w-6 text-center text-sm text-text-muted tabular">{i + 1}</span>
              <Input aria-label={`Stage ${i + 1} name`} value={s.name} onChange={(e) => upd(i, "name", e.target.value)} maxLength={60} className="sm:flex-1" />
              <Select size="sm" value={s.group} onValueChange={(v) => upd(i, "group", v)} disabled={s.inUse > 0} options={STAGE_GROUPS.map((g) => ({ value: g.value, label: g.label }))} className="sm:w-36" />
              <Select size="sm" value={s.onEnterEmailKey ?? "none"} onValueChange={(v) => upd(i, "onEnterEmailKey", v === "none" ? null : v)} options={[{ value: "none", label: "No email on entry" }, ...EMAIL_TEMPLATE_KEYS.map((k) => ({ value: k.key, label: `Email: ${k.label}` }))]} className="sm:w-52" />
              <div className="flex gap-1">
                <IconButton size="icon-sm" label={`Move ${s.name} up`} disabled={i === 0} onClick={() => swap(i, i - 1)}><ArrowUp /></IconButton>
                <IconButton size="icon-sm" label={`Move ${s.name} down`} disabled={i === stages.length - 1} onClick={() => swap(i, i + 1)}><ArrowDown /></IconButton>
                <IconButton size="icon-sm" label={`Remove ${s.name}`} disabled={s.inUse > 0} title={s.inUse ? "Has candidates" : undefined} onClick={() => setStages((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>
              </div>
            </li>
          ))}
        </ol>
        <Button className="self-start" variant="ghost" size="sm" onClick={() => setStages((s) => { const at = Math.max(0, s.findIndex((x) => x.group === "offer")); const n = [...s]; n.splice(at, 0, { id: null, name: "", group: "interview", onEnterEmailKey: null, inUse: 0 }); return n; })}><Plus />Add a stage</Button>
        <p className="text-sm text-text-muted">“Email on entry” sends that template to the candidate automatically whenever they move into the stage.</p>
      </div>
    </Modal>
  );
}

// ---------- scorecards and scales ----------
function Scorecards({ cards, canEdit }: Props) {
  const [card, setCard] = React.useState<ScorecardRow | "new" | null>(null);
  const [scale, setScale] = React.useState<ScaleRow | "new" | null>(null);
  const scaleName = (id: string) => cards.scales.find((s) => s.id === id)?.name ?? "";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Scorecards" description="What interviewers rate." action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setCard("new")}><Plus />New</Button> : undefined} />
        <ul className="divide-y divide-border border-t border-border">
          {cards.cards.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-5 py-3">
              <div className="flex-1"><p className="font-medium">{c.name}</p><p className="text-sm text-text-muted">{c.sections.reduce((n, s) => n + s.criteria.length, 0)} criteria · {scaleName(c.rating_scale_id)} · {c.used} submitted</p></div>
              {canEdit && <IconButton size="icon-sm" label={`Edit ${c.name}`} onClick={() => setCard(c)}><Pencil /></IconButton>}
              {canEdit && !c.used && <ConfirmDialog title={`Delete ${c.name}?`} description="This can't be undone." confirmLabel="Delete" onConfirm={async () => done(await deleteScorecardAction(c.id), "Deleted")} trigger={<IconButton size="icon-sm" label={`Delete ${c.name}`}><Trash2 /></IconButton>} />}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Rating scales" action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setScale("new")}><Plus />New</Button> : undefined} />
        <ul className="divide-y divide-border border-t border-border">
          {cards.scales.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-5 py-3">
              <div className="flex-1"><p className="font-medium">{s.name}</p><p className="text-sm text-text-muted">{s.points.map((x) => `${x.value} ${x.label}`).join(" · ")}</p></div>
              {canEdit && <IconButton size="icon-sm" label={`Edit ${s.name}`} onClick={() => setScale(s)}><Pencil /></IconButton>}
              {canEdit && !s.used && <ConfirmDialog title={`Delete ${s.name}?`} description="This can't be undone." confirmLabel="Delete" onConfirm={async () => done(await deleteScaleAction(s.id), "Deleted")} trigger={<IconButton size="icon-sm" label={`Delete ${s.name}`}><Trash2 /></IconButton>} />}
            </li>
          ))}
        </ul>
      </Card>
      {card && <CardDialog card={card === "new" ? null : card} scales={cards.scales} onClose={() => setCard(null)} />}
      {scale && <ScaleDialog scale={scale === "new" ? null : scale} onClose={() => setScale(null)} />}
    </div>
  );
}

function CardDialog({ card, scales, onClose }: { card: ScorecardRow | null; scales: ScaleRow[]; onClose: () => void }) {
  const [name, setName] = React.useState(card?.name ?? "");
  const [scaleId, setScaleId] = React.useState(card?.rating_scale_id ?? scales[0]?.id ?? "");
  const [overall, setOverall] = React.useState(card?.overall_rating ?? false);
  const [sections, setSections] = React.useState(card?.sections.map((s) => ({ title: s.title, criteria: s.criteria.map((c) => ({ id: c.id as string | null, label: c.label })) })) ?? [{ title: "Skills", criteria: [{ id: null, label: "" }] }]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={card ? `Edit ${card.name}` : "New scorecard"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => {
        const r = await saveScorecardAction(card?.id ?? null, { name, ratingScaleId: scaleId, overallRating: overall, sections });
        if (!r.ok) setError(r.error); else { toast.success("Scorecard saved"); onClose(); }
      })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Rating scale"><Select value={scaleId} onValueChange={setScaleId} options={scales.map((s) => ({ value: s.id, label: s.name }))} /></Field>
        </div>
        <Switch checked={overall} onCheckedChange={(c) => setOverall(!!c)} label="Ask for an overall rating (otherwise the average of the criteria is used)" />
        {sections.map((s, i) => (
          <fieldset key={i} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex gap-2"><Input aria-label={`Section ${i + 1} title`} value={s.title} onChange={(e) => setSections((x) => x.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} placeholder="Section title" />
              <IconButton label={`Remove section ${s.title}`} disabled={sections.length === 1} onClick={() => setSections((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton></div>
            {s.criteria.map((c, k) => (
              <div key={k} className="flex gap-2 pl-4"><Input aria-label={`Criterion ${k + 1} in ${s.title}`} value={c.label} onChange={(e) => setSections((x) => x.map((y, j) => (j === i ? { ...y, criteria: y.criteria.map((z, m) => (m === k ? { ...z, label: e.target.value } : z)) } : y)))} placeholder="What to rate" />
                <IconButton label="Remove criterion" disabled={s.criteria.length === 1} onClick={() => setSections((x) => x.map((y, j) => (j === i ? { ...y, criteria: y.criteria.filter((_, m) => m !== k) } : y)))}><Trash2 /></IconButton></div>
            ))}
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setSections((x) => x.map((y, j) => (j === i ? { ...y, criteria: [...y.criteria, { id: null, label: "" }] } : y)))}><Plus />Criterion</Button>
          </fieldset>
        ))}
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setSections((x) => [...x, { title: "", criteria: [{ id: null, label: "" }] }])}><Plus />Section</Button>
      </div>
    </Modal>
  );
}

function ScaleDialog({ scale, onClose }: { scale: ScaleRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(scale?.name ?? "");
  const [points, setPoints] = React.useState(scale?.points ?? [{ value: 1, label: "No" }, { value: 2, label: "Maybe" }, { value: 3, label: "Yes" }]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={scale ? `Edit ${scale.name}` : "New rating scale"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => {
        const r = await saveScaleAction(scale?.id ?? null, { name, points }); if (!r.ok) setError(r.error); else { toast.success("Scale saved"); onClose(); }
      })}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        {points.map((pt, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={`Point ${i + 1} value`} type="number" min={0} max={10} value={pt.value} onChange={(e) => setPoints((x) => x.map((y, j) => (j === i ? { ...y, value: Number(e.target.value) } : y)))} className="w-20" />
            <Input aria-label={`Point ${i + 1} label`} value={pt.label} onChange={(e) => setPoints((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} maxLength={40} />
            <IconButton label="Remove point" disabled={points.length <= 2} onClick={() => setPoints((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>
          </div>
        ))}
        <Button size="sm" variant="ghost" className="self-start" disabled={points.length >= 10} onClick={() => setPoints((x) => [...x, { value: (x.at(-1)?.value ?? 0) + 1, label: "" }])}><Plus />Point</Button>
      </div>
    </Modal>
  );
}

// ---------- templates ----------
function Templates({ jds, emails, offers, canEdit }: Props) {
  const [jd, setJd] = React.useState<JdTemplate | "new" | null>(null);
  const [offer, setOffer] = React.useState<OfferTemplate | "new" | null>(null);
  const [email, setEmail] = React.useState<EmailTemplate | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Offer letters" description="Merged with the offer's details and signed by the candidate." action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setOffer("new")}><Plus />New</Button> : undefined} />
        {offers.length === 0 ? <EmptyState compact title="No offer letter templates" /> : <ul className="divide-y divide-border border-t border-border">{offers.map((o) => (
          <li key={o.id} className="flex items-center gap-2 px-5 py-3"><span className="flex-1 font-medium">{o.name}<span className="block text-sm font-normal text-text-muted">used for {o.used} {o.used === 1 ? "offer" : "offers"}</span></span>
            {canEdit && <IconButton size="icon-sm" label={`Edit ${o.name}`} onClick={() => setOffer(o)}><Pencil /></IconButton>}
            {canEdit && <ConfirmDialog title={`Delete ${o.name}?`} description="Offers already made keep their letter." confirmLabel="Delete" onConfirm={async () => done(await deleteOfferTemplateAction(o.id), "Deleted")} trigger={<IconButton size="icon-sm" label={`Delete ${o.name}`}><Trash2 /></IconButton>} />}</li>
        ))}</ul>}
      </Card>
      <Card>
        <CardHeader title="Job descriptions" description="Starting points in the create-job wizard." action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setJd("new")}><Plus />New</Button> : undefined} />
        {jds.length === 0 ? <EmptyState compact title="No templates" /> : <ul className="divide-y divide-border border-t border-border">{jds.map((j) => (
          <li key={j.id} className="flex items-center gap-2 px-5 py-3"><span className="flex-1 font-medium">{j.name}</span>
            {canEdit && <IconButton size="icon-sm" label={`Edit ${j.name}`} onClick={() => setJd(j)}><Pencil /></IconButton>}
            {canEdit && <ConfirmDialog title={`Delete ${j.name}?`} description="Jobs already posted keep their text." confirmLabel="Delete" onConfirm={async () => done(await deleteJdTemplateAction(j.id), "Deleted")} trigger={<IconButton size="icon-sm" label={`Delete ${j.name}`}><Trash2 /></IconButton>} />}</li>
        ))}</ul>}
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Emails to candidates" description="Sent when you schedule interviews, send offers or reject, and by stage automations." />
        <ul className="divide-y divide-border border-t border-border">{emails.map((e) => (
          <li key={e.key} className="flex items-center gap-2 px-5 py-3"><span className="min-w-0 flex-1"><span className="font-medium">{e.label}</span><span className="block truncate text-sm text-text-muted">{e.subject}</span></span>
            {canEdit && <IconButton size="icon-sm" label={`Edit ${e.label}`} onClick={() => setEmail(e)}><Pencil /></IconButton>}</li>
        ))}</ul>
      </Card>
      {jd && <HtmlTemplateDialog title={jd === "new" ? "New job description template" : `Edit ${jd.name}`} name={jd === "new" ? "" : jd.name} html={jd === "new" ? "" : jd.description_html}
        save={(n, h) => saveJdTemplateAction(jd === "new" ? null : jd.id, n, h)} onClose={() => setJd(null)} />}
      {offer && <HtmlTemplateDialog title={offer === "new" ? "New offer letter" : `Edit ${offer.name}`} name={offer === "new" ? "" : offer.name} html={offer === "new" ? "<p>Dear {{candidate.first_name}},</p><p></p>" : offer.body_html}
        placeholders={OFFER_PLACEHOLDERS} save={(n, h) => saveOfferTemplateAction(offer === "new" ? null : offer.id, n, h)} onClose={() => setOffer(null)} />}
      {email && <EmailTemplateDialog t={email} onClose={() => setEmail(null)} />}
    </div>
  );
}

function HtmlTemplateDialog({ title, name: n0, html: h0, placeholders, save, onClose }: { title: string; name: string; html: string; placeholders?: readonly { key: string; label: string }[]; save: (name: string, html: string) => Promise<Res>; onClose: () => void }) {
  const [name, setName] = React.useState(n0);
  const [html, setHtml] = React.useState(h0);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => { const r = await save(name, html); if (!r.ok) setError(r.error ?? "Couldn't save."); else { toast.success("Template saved"); onClose(); } })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <RichText label="Text" initial={h0} onChange={setHtml} placeholders={placeholders} minHeight="min-h-72" />
      </div>
    </Modal>
  );
}

function EmailTemplateDialog({ t, onClose }: { t: EmailTemplate; onClose: () => void }) {
  const [subject, setSubject] = React.useState(t.subject);
  const [body, setBody] = React.useState(t.body.includes("<p>") ? htmlToText(t.body) : t.body);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={t.label}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => { const r = await saveEmailTemplateAction(t.key, subject, body); if (!r.ok) setError(r.error); else { toast.success("Email saved"); onClose(); } })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Subject" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
        <Field label="Message" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={5000} /></Field>
        <p className="text-sm text-text-muted">Fields you can use: {EMAIL_PLACEHOLDERS.map((p) => <code key={p.key} className="mx-0.5 rounded-xs bg-surface-sunken px-1 text-xs" title={p.label}>{`{{${p.key}}}`}</code>)}</p>
      </div>
    </Modal>
  );
}

// ---------- careers page ----------
function Careers({ site, canEdit, subdomain }: Props) {
  const [title, setTitle] = React.useState(site?.title ?? "");
  const [about, setAbout] = React.useState(site?.about_html ? htmlToText(site.about_html) : "");
  const [tagline, setTagline] = React.useState(site?.branding.tagline ?? "");
  const [busy, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title="Careers page" description="Public page listing jobs published to the careers page, with an apply form." action={<Button asChild size="sm" variant="secondary"><a href="/careers" target="_blank" rel="noopener"><Globe />Open<span className="sr-only"> (opens in a new tab)</span></a></Button>} />
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); start(async () => done(await saveCareerSiteAction(title, about, tagline), "Careers page saved")); }}>
          <p className="text-sm text-text-muted">Address: <code className="rounded-xs bg-surface-sunken px-1">{subdomain}.…/careers</code>. Applicants must agree to their details being stored; each address can apply at most 10 times an hour.</p>
          <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={!canEdit} /></Field>
          <Field label="Tagline"><Input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={160} disabled={!canEdit} /></Field>
          <Field label="About the company"><Textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={6} maxLength={4000} disabled={!canEdit} /></Field>
          {canEdit && <Button type="submit" className="self-start" loading={busy}>Save</Button>}
        </form>
      </CardBody>
    </Card>
  );
}

// ---------- approvals ----------
function Approvals({ chains, people, canEdit }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChainEditor entity="requisition" title="Requisitions" fallback="The requester's manager, then an HR admin." levels={chains.requisition} roles={chains.roles} people={people} canEdit={canEdit} />
      <ChainEditor entity="offer" title="Offers" fallback="The job's hiring managers, then an HR admin. The person making the offer and the candidate never approve it." levels={chains.offer} roles={chains.roles} people={people} canEdit={canEdit} />
    </div>
  );
}

function ChainEditor({ entity, title, fallback, levels: l0, roles, people, canEdit }: { entity: "requisition" | "offer"; title: string; fallback: string; levels: ChainLevel[] | null; roles: { key: string; name: string }[]; people: { id: string; name: string; title: string | null }[]; canEdit: boolean }) {
  const [levels, setLevels] = React.useState<ChainLevel[]>(l0 ?? []);
  const [busy, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title={title} description={levels.length ? "Each level approves in turn." : `Built-in chain: ${fallback}`} />
      <CardBody className="flex flex-col gap-3">
        {levels.map((l, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-center">
            <span className="text-sm text-text-muted">Level {i + 1}</span>
            <Select size="sm" value={l.approver} disabled={!canEdit} onValueChange={(v) => setLevels((x) => x.map((y, j) => (j === i ? { approver: v as ChainLevel["approver"] } : y)))}
              options={[{ value: "manager", label: "Requester's manager" }, { value: "l2_manager", label: "Manager's manager" }, { value: "role", label: "Someone with a role" }, { value: "employee", label: "A named person" }]} className="sm:w-52" />
            {l.approver === "role" && <Select size="sm" value={l.role ?? ""} disabled={!canEdit} onValueChange={(v) => setLevels((x) => x.map((y, j) => (j === i ? { ...y, role: v } : y)))} options={roles.map((r) => ({ value: r.key, label: r.name }))} placeholder="Pick a role" className="sm:w-44" />}
            {l.approver === "employee" && <div className="sm:w-56"><EmployeePicker people={people} value={l.id ? [l.id] : []} onChange={(ids) => setLevels((x) => x.map((y, j) => (j === i ? { ...y, id: ids[0] } : y)))} /></div>}
            {canEdit && <IconButton size="icon-sm" label={`Remove level ${i + 1}`} className="sm:ml-auto" onClick={() => setLevels((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>}
          </div>
        ))}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={levels.length >= 5} onClick={() => setLevels((x) => [...x, { approver: "role", role: "hr_admin" }])}><Plus />Add level</Button>
            <Button size="sm" loading={busy} onClick={() => start(async () => done(await saveChainAction(entity, levels), levels.length ? "Approval chain saved" : "Back to the built-in chain"))}>Save</Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- candidate fields ----------
function Fields({ fields, canEdit }: Props) {
  const [editing, setEditing] = React.useState<FieldDef | "new" | null>(null);
  return (
    <Card>
      <CardHeader title="Extra candidate fields" description="Asked when adding a candidate and shown on their profile." action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setEditing("new")}><Plus />New field</Button> : undefined} />
      {fields.length === 0 ? <EmptyState compact title="No extra fields" description="For example notice period or expected CTC." /> : (
        <ul className="divide-y divide-border border-t border-border">{fields.map((f) => (
          <li key={f.id} className="flex items-center gap-2 px-5 py-3"><span className="flex-1"><span className="font-medium">{f.label}</span><span className="block text-sm text-text-muted">{f.type === "select" ? `Pick from: ${f.options?.join(", ")}` : f.type}{f.required ? " · required" : ""}</span></span>
            {canEdit && <IconButton size="icon-sm" label={`Edit ${f.label}`} onClick={() => setEditing(f)}><Pencil /></IconButton>}
            {canEdit && <ConfirmDialog title={`Remove ${f.label}?`} description="Values already entered are kept but no longer shown." confirmLabel="Remove" onConfirm={async () => done(await deleteFieldAction(f.id), "Field removed")} trigger={<IconButton size="icon-sm" label={`Remove ${f.label}`}><Trash2 /></IconButton>} />}</li>
        ))}</ul>
      )}
      {editing && <FieldDialog field={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function FieldDialog({ field, onClose }: { field: FieldDef | null; onClose: () => void }) {
  const [label, setLabel] = React.useState(field?.label ?? "");
  const [type, setType] = React.useState<string>(field?.type ?? "text");
  const [options, setOptions] = React.useState((field?.options ?? []).join(", "));
  const [required, setRequired] = React.useState(field?.required ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={field ? `Edit ${field.label}` : "New candidate field"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => start(async () => { const r = await saveFieldAction(field?.id ?? null, { label, type, options: options.split(","), required }); if (!r.ok) setError(r.error); else { toast.success("Field saved"); onClose(); } })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></Field>
        <Field label="Type"><Select value={type} onValueChange={setType} options={[{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "select", label: "Pick from a list" }]} /></Field>
        {type === "select" && <Field label="Choices" help="Comma separated"><Input value={options} onChange={(e) => setOptions(e.target.value)} /></Field>}
        <Checkbox label="Required" checked={required} onCheckedChange={(c) => setRequired(!!c)} />
      </div>
    </Modal>
  );
}

// ---------- integrations ----------
function Integrations({ calendar }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><CalendarCheck className="size-4" aria-hidden />Calendar sync</span>} action={<Badge tone={calendar.configured ? "success" : "neutral"}>{calendar.configured ? calendar.provider : "Not configured"}</Badge>} />
        <CardBody className="text-base text-text-muted">
          {calendar.configured ? "Keys are present. Interviews still go out by email and calendar file until each interviewer connects their calendar."
            : <>Not configured: add {calendar.missing.join(" ")} in .env.local to turn on Google or Microsoft calendar sync. Until then interviewers get an email and a calendar file (.ics) for each interview.</>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Job boards" action={<Badge>Not available</Badge>} />
        <CardBody className="text-base text-text-muted">Posting to LinkedIn or Naukri needs partner agreements and isn&apos;t offered. Share your careers page link on job boards instead.</CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Stage groups" />
        <CardBody className="flex flex-wrap gap-2">{STAGE_GROUPS.map((g) => <StageBadge key={g.value} group={g.value} label={groupLabel(g.value)} />)}</CardBody>
      </Card>
    </div>
  );
}
