"use client";
import * as React from "react";
import { Crosshair, Fingerprint, MapPin, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { Switch } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { deleteCaptureAction, saveCaptureAction } from "@/app/(app)/settings/time/actions";
import type { CaptureRow } from "@/server/modules/attendance/policies";

type FenceDraft = { key: string; id?: string; name: string; lat: string; lng: string; radius: string };
let seq = 0;
const newKey = () => `f${++seq}`;

export function CaptureSettings({ rows, canEdit }: { rows: CaptureRow[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<CaptureRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<CaptureRow | null>(null);
  return (
    <Card>
      <CardHeader title="Clock-in rules" description="Where people can clock in from, what they can ask for and how often. People without a policy get the default."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add policy</Button> : undefined} />
      {rows.length === 0 ? (
        <EmptyState compact icon={<Fingerprint />} title="No clock-in rules yet" />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name}{r.is_default && <Badge tone="success">Default</Badge>}</p>
                <p className="text-sm text-text-muted">
                  {[
                    r.web.enabled ? (r.web.ip_ranges.length ? `Browser from ${r.web.ip_ranges.length} office ${r.web.ip_ranges.length === 1 ? "network" : "networks"}` : "Browser from anywhere") : "Browser off",
                    r.mobile.enabled && r.fences.length ? `location at ${r.fences.map((f) => f.name).join(", ")}${r.mobile.selfie ? " with selfie" : ""}${r.mobile.first_clock_in_approval ? ", new devices approved" : ""}` : null,
                    `${r.limits.regularization_per_month} regularizations a month`,
                    `${r.people} ${r.people === 1 ? "person" : "people"}`,
                  ].filter(Boolean).join(" · ")}
                </p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "Delete", icon: <Trash2 />, danger: true, disabled: r.is_default, onSelect: () => setDeleting(r) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <CaptureDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Its locations are deleted too. People on this policy must be moved first." confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteCaptureAction(deleting.id); if (r.ok) toast.success(`${deleting.name} deleted`); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function CaptureDialog({ row, onClose }: { row: CaptureRow | null; onClose: () => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [webOn, setWebOn] = React.useState(row?.web.enabled ?? true);
  const [comment, setComment] = React.useState(row?.web.comment_required ?? false);
  const [ranges, setRanges] = React.useState((row?.web.ip_ranges ?? []).join("\n"));
  const [geoOn, setGeoOn] = React.useState(row?.mobile.enabled ?? true);
  const [selfie, setSelfie] = React.useState(row?.mobile.selfie ?? false);
  const [firstApproval, setFirstApproval] = React.useState(row?.mobile.first_clock_in_approval ?? false);
  const [accuracy, setAccuracy] = React.useState(row?.mobile.accuracy_m == null ? "" : String(row.mobile.accuracy_m));
  const [fences, setFences] = React.useState<FenceDraft[]>((row?.fences ?? []).map((f) => ({ key: newKey(), id: f.id, name: f.name, lat: String(f.lat), lng: String(f.lng), radius: String(f.radius_m) })));
  const [wfh, setWfh] = React.useState(row?.remote.wfh ?? true);
  const [od, setOd] = React.useState(row?.remote.od ?? true);
  const [regs, setRegs] = React.useState(String(row?.limits.regularization_per_month ?? 3));
  const [days, setDays] = React.useState(String(row?.limits.regularization_past_days ?? 7));
  const [partial, setPartial] = React.useState(String((row?.limits.partial_day_minutes_per_month ?? 240) / 60));
  const [error, setError] = React.useState<string | null>(null);
  const [locating, setLocating] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const patch = (key: string, p: Partial<FenceDraft>) => setFences((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const here = (key: string) => {
    if (!navigator.geolocation) { setError("This browser can't share its location. Type the latitude and longitude instead."); return; }
    setLocating(key);
    navigator.geolocation.getCurrentPosition(
      (p) => { patch(key, { lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) }); setLocating(null); },
      (e) => { setLocating(null); setError(e.code === e.PERMISSION_DENIED ? "Location is blocked for this site. Allow it in the browser's site settings, or type the coordinates." : "We couldn't get your location. Type the coordinates instead."); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const save = () => start(async () => {
    setError(null);
    const r = await saveCaptureAction(row?.id ?? null, {
      name,
      web: { enabled: webOn, comment_required: comment, ip_ranges: ranges.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) },
      mobile: { enabled: geoOn, fences: fences.map((f) => ({ id: f.id ?? null, name: f.name, lat: Number(f.lat), lng: Number(f.lng), radius_m: Math.round(Number(f.radius)) })), selfie, first_clock_in_approval: firstApproval, accuracy_m: accuracy.trim() === "" ? null : Math.round(Number(accuracy)) },
      remote: { wfh, od },
      limits: { regularization_per_month: Number(regs), regularization_past_days: Number(days), partial_day_minutes_per_month: Math.round(Number(partial) * 60) },
    });
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? `${name} updated` : `${name} added`);
    onClose();
  });

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit clock-in rules" : "Add clock-in rules"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : "Add policy"}</Button></>}>
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Office only" /></Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">Browser clock-in</legend>
          <Switch label="Allow clocking in from a browser" checked={webOn} onCheckedChange={setWebOn} />
          <Switch label="Ask for a comment with every clock-in" checked={comment} onCheckedChange={setComment} />
          <Field label="Office networks" help="One IP address or range per line, like 203.0.113.10 or 10.0.0.0/8. Leave empty to allow any network.">
            <Textarea value={ranges} onChange={(e) => setRanges(e.target.value)} disabled={!webOn} rows={3} className="font-mono text-sm" spellCheck={false} />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">Location clock-in</legend>
          <Switch label="Allow clocking in from inside these locations (browser location)" checked={geoOn} onCheckedChange={setGeoOn} />
          <p className="text-sm text-text-muted">When someone isn&apos;t on an office network, their browser shares its location and must be inside one of these circles. Only a fresh reading counts, never a remembered position.</p>
          {fences.length === 0 && <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-muted">No locations yet.</p>}
          <ul className="flex flex-col gap-3">
            {fences.map((f, i) => (
              <li key={f.key} className="rounded-md border border-border p-3">
                <div className="flex items-start gap-2">
                  <Field label={`Location ${i + 1} name`} className="flex-1"><Input value={f.name} onChange={(e) => patch(f.key, { name: e.target.value })} maxLength={80} placeholder="e.g. Pune office" /></Field>
                  <IconButton className="mt-6" label={`Remove ${f.name || `location ${i + 1}`}`} size="icon-sm" type="button" onClick={() => setFences((fs) => fs.filter((x) => x.key !== f.key))}><X /></IconButton>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_8rem]">
                  <Field label="Latitude"><Input inputMode="decimal" value={f.lat} onChange={(e) => patch(f.key, { lat: e.target.value })} placeholder="12.9716" /></Field>
                  <Field label="Longitude"><Input inputMode="decimal" value={f.lng} onChange={(e) => patch(f.key, { lng: e.target.value })} placeholder="77.5946" /></Field>
                  <Field label="Radius (m)" help="20 to 5000"><Input type="number" inputMode="numeric" min={20} max={5000} value={f.radius} onChange={(e) => patch(f.key, { radius: e.target.value })} /></Field>
                </div>
                <Button type="button" variant="ghost" size="sm" className="mt-2" loading={locating === f.key} onClick={() => here(f.key)}><Crosshair />Use my current location</Button>
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => setFences((fs) => [...fs, { key: newKey(), name: "", lat: "", lng: "", radius: "200" }])} disabled={fences.length >= 20}><MapPin />Add location</Button>
          <Field label="Location accuracy limit (m)" help="Readings less precise than this are refused. Empty for no limit; 100 suits most phones outdoors." className="max-w-xs">
            <Input type="number" inputMode="numeric" min={10} max={5000} value={accuracy} onChange={(e) => setAccuracy(e.target.value)} disabled={!geoOn} placeholder="No limit" />
          </Field>
          <Switch label="Take a selfie with every location clock-in" checked={selfie} onCheckedChange={setSelfie} disabled={!geoOn} />
          <p className="text-sm text-text-muted">The photo is stored with the clock-in and shown to the person, their manager and attendance admins on the person&apos;s Time tab. erp never compares faces or recognises anyone from it.</p>
          <Switch label="The first clock-in from a new device needs the manager's approval" checked={firstApproval} onCheckedChange={setFirstApproval} disabled={!geoOn} />
          <p className="text-sm text-text-muted">A clock-in from a browser the person hasn&apos;t used at that location before waits in the manager&apos;s inbox. Once approved, that device is trusted there.</p>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold">Remote work</legend>
          <Switch label="People can ask to work from home" checked={wfh} onCheckedChange={setWfh} />
          <Switch label="People can ask to be on duty (client site, travel)" checked={od} onCheckedChange={setOd} />
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-3 text-base font-semibold">Limits</legend>
          <Field label="Regularizations a month"><Input type="number" inputMode="numeric" min={0} max={31} value={regs} onChange={(e) => setRegs(e.target.value)} /></Field>
          <Field label="How far back (days)" help="For regularize, WFH and partial day"><Input type="number" inputMode="numeric" min={0} max={90} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label="Partial days a month (hours)"><Input type="number" inputMode="decimal" min={0} max={40} step={0.5} value={partial} onChange={(e) => setPartial(e.target.value)} /></Field>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
