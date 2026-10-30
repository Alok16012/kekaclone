"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, History, Laptop, PackagePlus, Send } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { acknowledgeAssetAction, cancelAssetRequestAction, requestAssetAction } from "@/app/(app)/me/assets/actions";
import { formatPaise } from "@/server/modules/assets/rules";
import type { PersonAssetsDTO, RequestDTO } from "./types";
import { ConditionText, fmtDay, RequestStatusBadge } from "./bits";

export type RequestableType = { id: string; name: string; category: string };

/** What someone holds, what they returned and what they asked for. On your own profile you can confirm receipt and cancel requests. */
export function PersonAssets({ data, name, requestable = [], showRequestButton = false }: { data: PersonAssetsDTO; name: string; requestable?: RequestableType[]; showRequestButton?: boolean }) {
  const [busy, start] = React.useTransition();
  const [cancel, setCancel] = React.useState<RequestDTO | null>(null);
  const ack = (id: string) => start(async () => {
    const r = await acknowledgeAssetAction(id);
    if (r.ok) toast.success("Thanks, receipt confirmed"); else toast.error(r.error);
  });
  const pendingAck = data.open.filter((a) => a.requires_ack && !a.acknowledged_at).length;
  const openRequests = data.requests.filter((r) => r.status === "pending" || r.status === "approved");
  const pastRequests = data.requests.filter((r) => r.status !== "pending" && r.status !== "approved");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={data.isSelf ? "Assets with you" : `Assets with ${name}`}
          description={pendingAck && data.isSelf ? `Please confirm you received ${pendingAck === 1 ? "this asset" : `these ${pendingAck} assets`}.` : data.isSelf ? "Company equipment issued to you." : undefined}
          action={showRequestButton && data.isSelf && requestable.length > 0 ? <RequestAsset types={requestable} /> : !data.isSelf && data.canManage ? <Button asChild variant="secondary" size="sm"><Link href="/org/assets">Manage in Assets</Link></Button> : undefined} />
        {data.open.length === 0 ? (
          <EmptyState compact icon={<Laptop />} title="No assets" description={data.isSelf ? "Laptops, ID cards and other equipment issued to you will show here." : "Nothing is issued right now."} />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {data.open.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                <Laptop className="hidden size-5 shrink-0 text-text-muted sm:block" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{a.name}</p>
                  <p className="truncate text-sm text-text-muted">{[a.tag, a.type, a.serial_number && `S/N ${a.serial_number}`, `since ${fmtDay(a.assigned_at)}`].filter(Boolean).join(" · ")}</p>
                </div>
                {a.acknowledged_at ? <Badge tone="success"><CheckCircle2 aria-hidden />Received {fmtDay(a.acknowledged_at)}</Badge>
                  : a.requires_ack ? (data.isSelf ? <Button size="sm" loading={busy} onClick={() => ack(a.id)}><CheckCircle2 />I have received it</Button> : <Badge tone="warning">Not confirmed yet</Badge>)
                  : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(data.requests.length > 0 || (data.isSelf && showRequestButton)) && (
        <Card>
          <CardHeader title="Requests" description={data.isSelf ? "Ask for equipment you need. Your manager approves, then the asset team hands it over." : undefined} />
          {data.requests.length === 0 ? <EmptyState compact icon={<PackagePlus />} title="No requests" /> : (
            <ul className="divide-y divide-border border-t border-border">
              {[...openRequests, ...pastRequests].map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium">{r.type}{r.kind === "replacement" ? " (replacement)" : ""}</p>
                    <p className="text-sm text-text-muted">{fmtDay(r.created_at)}{r.reason ? ` · ${r.reason}` : ""}</p>
                  </div>
                  <RequestStatusBadge status={r.status} />
                  {data.isSelf && (r.status === "pending" || r.status === "approved") && <Button variant="ghost" size="sm" onClick={() => setCancel(r)}>Cancel</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {data.history.length > 0 && (
        <Card>
          <CardHeader title="Returned" />
          <ul className="divide-y divide-border border-t border-border">
            {data.history.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
                <History className="hidden size-4 shrink-0 text-text-muted sm:block" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base">{h.asset} <span className="text-sm text-text-muted">· {h.tag}</span></p>
                  <p className="text-sm text-text-muted">{fmtDay(h.assigned_at)} to {fmtDay(h.returned_at)} · returned <ConditionText condition={h.return_condition} />{h.return_notes ? ` · ${h.return_notes}` : ""}</p>
                </div>
                {BigInt(h.recovery_paise) > BigInt(0) && <Badge tone="danger">Recovery ₹{formatPaise(BigInt(h.recovery_paise))}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog open={!!cancel} onOpenChange={(o) => !o && setCancel(null)} title="Cancel this request?" description={`Your request for a ${cancel?.type.toLowerCase() ?? "asset"} will be withdrawn.`} confirmLabel="Cancel request"
        onConfirm={async () => { if (!cancel) return; const r = await cancelAssetRequestAction(cancel.id); if (r.ok) toast.success("Request cancelled"); else toast.error(r.error); setCancel(null); }} />
    </div>
  );
}

export function RequestAsset({ types, defaultOpen = false }: { types: RequestableType[]; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [typeId, setTypeId] = React.useState("");
  const [kind, setKind] = React.useState<"new" | "replacement">("new");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!typeId) errs.typeId = "Pick what you need.";
    if (kind === "replacement" && !reason.trim()) errs.reason = "Tell us what's wrong with the one you have.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    start(async () => {
      const r = await requestAssetAction({ typeId, kind, reason: reason || null });
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success("Request sent", { description: r.data?.status === "approved" ? "The asset team will hand it over." : "Your manager will review it." });
      setOpen(false); setTypeId(""); setReason(""); setKind("new");
    });
  };
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) setErrors({}); }} title="Request an asset" trigger={<Button size="sm"><PackagePlus />Request an asset</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="asset-request" loading={busy}><Send />Send request</Button></>}>
      <form id="asset-request" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="What do you need?" required error={errors.typeId}>
          <Select value={typeId || undefined} onValueChange={setTypeId} placeholder="Pick a type" options={types.map((t) => ({ value: t.id, label: `${t.name} · ${t.category}` }))} />
        </Field>
        <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">This is</span>
          <Segmented label="Request kind" value={kind} onChange={setKind} options={[{ value: "new", label: "Something new" }, { value: "replacement", label: "A replacement" }]} /></div>
        <Field label={kind === "replacement" ? "What's wrong with the current one?" : "Why do you need it?"} required={kind === "replacement"} error={errors.reason}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
      </form>
    </Modal>
  );
}
