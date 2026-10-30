"use client";
import * as React from "react";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Checkbox } from "@/ui/choice";
import { toast } from "@/ui/toast";
import { recordVerificationAction } from "@/app/(app)/settings/payroll/statutory/actions";

/** "Record CA verification": who checked, when, a note, and an explicit confirmation. */
export function RecordVerification({ fingerprint, count, today }: { fingerprint: string; count: number; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [on, setOn] = React.useState(today);
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [err, setErr] = React.useState<{ field?: string; error: string } | null>(null);
  const [pending, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await recordVerificationAction({ verifiedByName: name, verifiedOn: on, note, confirm: confirm as true, fingerprint });
      if (r.ok) {
        toast.success(r.data?.alreadyRecorded ? "Already recorded for these rates" : "CA verification recorded");
        setOpen(false); setErr(null);
      } else setErr({ field: r.field, error: r.error });
    });
  };
  const fieldErr = (f: string) => (err?.field === f ? err.error : undefined);
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) setErr(null); }} title="Record CA verification"
      description={`Confirms that a chartered accountant has checked all ${count} rate tables on this page for your company.`}
      trigger={<Button><BadgeCheck aria-hidden />Record CA verification</Button>}
      footer={<>
        <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" form="ca-verification" loading={pending} disabled={!confirm}>Record verification</Button>
      </>}>
      <form id="ca-verification" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Checked by" required help="The CA or firm, e.g. “R. Iyer & Co., Chartered Accountants”." error={fieldErr("verifiedByName")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Date they signed off" required error={fieldErr("verifiedOn")}>
          <Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} />
        </Field>
        <Field label="Note" required help="Membership number, what was checked, anything they changed in your payroll settings." error={fieldErr("note")}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <Checkbox checked={confirm} onCheckedChange={(c) => setConfirm(c === true)}
          label="A chartered accountant reviewed every rate on this page and confirmed it is right for our company." />
        {err && !["verifiedByName", "verifiedOn", "note"].includes(err.field ?? "") && <p role="alert" className="text-sm text-danger-text">{err.error}</p>}
      </form>
    </Modal>
  );
}
