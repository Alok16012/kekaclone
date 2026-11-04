"use client";
import * as React from "react";
import { Copy, Fingerprint, KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { createDeviceAction, deleteDeviceAction, rotateDeviceKeyAction, updateDeviceAction } from "@/app/(app)/settings/time/actions";
import type { DeviceRow } from "@/server/modules/attendance/devices";

const VENDORS = [{ value: "generic", label: "Generic / other" }, { value: "zkteco", label: "ZKTeco" }, { value: "essl", label: "eSSL" }, { value: "matrix", label: "Matrix" }, { value: "biomax", label: "Biomax" }];
const PROTOCOLS = [{ value: "json", label: "erp push API (JSON, with a key)" }, { value: "adms", label: "ADMS push (ZKTeco / eSSL, by serial number)" }];
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Kathmandu", "Asia/Dhaka", "Asia/Colombo", "Europe/London", "America/New_York", "UTC"];
/** Biometric devices and their API keys. A key is shown once when created or rotated. */
export function DevicesSettings({ rows, locations, host }: { rows: DeviceRow[]; locations: { id: string; name: string }[]; host: string }) {
  const [editing, setEditing] = React.useState<DeviceRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<DeviceRow | null>(null);
  const [rotating, setRotating] = React.useState<DeviceRow | null>(null);
  const [key, setKey] = React.useState<{ name: string; key: string } | null>(null);
  const url = `https://${host}/api/v1/punches`;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Biometric devices" description="Each device pushes its punches with its own key. Punches are matched to people by attendance number (or employee number) and are safe to resend."
          action={<Button size="sm" onClick={() => setEditing("new")}><Plus />Add device</Button>} />
        {rows.length === 0 ? <EmptyState compact icon={<Fingerprint />} title="No devices yet" description="Add a device to get a key for its push integration." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {rows.map((r) => {
              const stale = !r.online;
              return (
                <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-base font-medium">{r.name} <span className="text-sm font-normal text-text-muted">{r.serial}</span>
                      <Badge tone={stale ? "warning" : "success"}>{r.last_seen_at ? (stale ? "Offline" : "Online") : "Never synced"}</Badge></p>
                    <p className="text-sm text-text-muted">{VENDORS.find((v) => v.value === r.vendor)?.label ?? r.vendor}{r.protocol === "adms" ? ` · ADMS · ${r.timezone}${r.clock_offset_seconds ? ` (clock ${r.clock_offset_seconds > 0 ? "+" : ""}${r.clock_offset_seconds}s)` : ""}` : ""}{r.location ? ` · ${r.location}` : ""} · last sync {r.last_seen_ago} · {r.punches_today} today, {r.punches_total} total</p>
                    {r.last_error && <p className="text-sm text-warning-text">Last push: {r.last_error}</p>}
                  </div>
                  <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="icon-sm"><MoreHorizontal /></IconButton>}
                    items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(r) }, { label: "New key", icon: <KeyRound />, disabled: r.protocol === "adms", onSelect: () => setRotating(r) }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(r) }]} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Push format" description="For the device vendor's middleware or your own script." />
        <CardBody>
          <pre className="overflow-x-auto rounded-md bg-surface-sunken p-3 text-xs leading-relaxed"><code>{`POST ${url}
Authorization: Bearer dev_…your device key…
Content-Type: application/json

{ "punches": [
  { "employee": "EMP0042", "at": "2026-11-03T09:31:00+05:30", "direction": "in", "external_id": "dev1-000123" }
] }`}</code></pre>
          <p className="mt-2 text-sm text-text-muted">Up to 500 punches a call, 60 calls a minute per device. <code>external_id</code> is the device&apos;s own record id, so a resent batch counts nothing twice. <code>direction</code> is optional (in, out or auto).</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="ZKTeco / eSSL devices (ADMS push)" description="These devices push their logs themselves, no middleware or PC needed. Add the device here with protocol ADMS and its serial number, then point the device at erp." />
        <CardBody className="flex flex-col gap-3 text-base">
          <ol className="list-decimal space-y-1 pl-5">
            <li>On the device: Menu → Comm. → <strong>Cloud Server Setting</strong> (eSSL: <strong>ADMS</strong>). Turn it on, set the server address to <code>{host}</code>, port <code>443</code> (or <code>80</code> without HTTPS), and turn <strong>Enable Domain Name</strong> on. Leave the proxy off.</li>
            <li>Set the device&apos;s time zone to the one you chose here and keep its clock right (NTP if the firmware has it). If the clock is always a little off, enter the difference as the clock offset below and erp corrects every punch.</li>
            <li>Enrol people with their <strong>attendance number</strong> (Settings → People) as the device user id (PIN). Unknown PINs are reported on the device row, not dropped silently.</li>
            <li>Restart the device. Within a minute it shows as online here and its logs arrive as punches; each log counts once even if the device resends it.</li>
          </ol>
          <p className="text-sm text-text-muted">What erp answers: <code>GET /iclock/cdata?SN=…</code> (handshake), <code>POST /iclock/cdata?SN=…&amp;table=ATTLOG</code> (logs), <code>GET /iclock/getrequest?SN=…</code> (no commands are ever sent). Only serial numbers added here with protocol ADMS are accepted, and only on your company&apos;s address.</p>
        </CardBody>
      </Card>
      {editing && <DeviceDialog row={editing === "new" ? null : editing} locations={locations} onClose={() => setEditing(null)} onKey={(name, k) => setKey({ name, key: k })} />}
      {rotating && <ConfirmDialog open onOpenChange={(o) => !o && setRotating(null)} title={`New key for ${rotating.name}?`} tone="primary" confirmLabel="Make a new key"
        description="The old key stops working at once. Update the device's integration with the new one."
        onConfirm={async () => { const r = await rotateDeviceKeyAction(rotating.id); if (r.ok && r.data) setKey({ name: rotating.name, key: r.data.key }); else if (!r.ok) toast.error(r.error); setRotating(null); }} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`} description="Its key stops working. Punches it already sent are kept." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteDeviceAction(deleting.id); if (r.ok) toast.success("Device deleted"); else toast.error(r.error); setDeleting(null); }} />}
      {key && <KeyDialog name={key.name} value={key.key} onClose={() => setKey(null)} />}
    </div>
  );
}

function DeviceDialog({ row, locations, onClose, onKey }: { row: DeviceRow | null; locations: { id: string; name: string }[]; onClose: () => void; onKey: (name: string, key: string) => void }) {
  const [name, setName] = React.useState(row?.name ?? "");
  const [serial, setSerial] = React.useState(row?.serial ?? "");
  const [vendor, setVendor] = React.useState(row?.vendor ?? "generic");
  const [locationId, setLocation] = React.useState(row?.location_id ?? "");
  const [protocol, setProtocol] = React.useState<"json" | "adms">(row?.protocol ?? "json");
  const [timezone, setTimezone] = React.useState(row?.timezone ?? "Asia/Kolkata");
  const [offset, setOffset] = React.useState(String(row?.clock_offset_seconds ?? 0));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const input = { name, serial, vendor, locationId: locationId || null, protocol, timezone, clockOffsetSeconds: Math.round(Number(offset) || 0) };
    const r = row ? await updateDeviceAction(row.id, input) : await createDeviceAction(input);
    if (!r.ok) { setError(r.error); return; }
    toast.success(row ? "Device updated" : "Device added");
    onClose();
    if (!row && r.data && "key" in r.data && protocol === "json") onKey(name, r.data.key);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={row ? "Edit device" : "Add device"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{row ? "Save" : protocol === "adms" ? "Add device" : "Add and show key"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Reception gate" /></Field>
        <Field label="Serial number" required help={row ? "Can't change after adding" : "Printed on the device"}><Input value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={64} disabled={!!row} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor"><Select value={vendor} onValueChange={setVendor} options={VENDORS} /></Field>
          <Field label="Location"><Select value={locationId} onValueChange={setLocation} placeholder="Not set" options={locations.map((l) => ({ value: l.id, label: l.name }))} /></Field>
        </div>
        <Field label="How it pushes" help={protocol === "adms" ? "The device is identified by its serial number; no key is needed. See the setup steps below the list." : "Your script or the vendor's middleware calls erp with the device key."}>
          <Select value={protocol} onValueChange={(v) => setProtocol(v as "json" | "adms")} options={PROTOCOLS} />
        </Field>
        {protocol === "adms" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Device time zone" help="The device sends local times without a zone."><Select value={timezone} onValueChange={setTimezone} options={[...new Set([timezone, ...ZONES])].map((z) => ({ value: z, label: z }))} /></Field>
            <Field label="Clock offset (seconds)" help="How far the device's clock runs ahead (negative if behind). 0 when it keeps time."><Input type="number" inputMode="numeric" min={-86400} max={86400} value={offset} onChange={(e) => setOffset(e.target.value)} /></Field>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function KeyDialog({ name, value, onClose }: { name: string; value: string; onClose: () => void }) {
  const copy = async () => { try { await navigator.clipboard.writeText(value); toast.success("Key copied"); } catch { toast.error("Couldn't copy. Select the key and copy it by hand."); } };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Key for ${name}`} description="Copy it now. For safety erp keeps only a fingerprint, so it can't be shown again; you can always make a new one."
      footer={<Button onClick={onClose}>I&apos;ve saved it</Button>}>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} aria-label="Device key" className="font-mono text-sm" onFocus={(e) => e.currentTarget.select()} />
        <IconButton label="Copy key" onClick={copy}><Copy /></IconButton>
      </div>
    </Modal>
  );
}
