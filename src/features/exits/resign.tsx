"use client";
import * as React from "react";
import Link from "next/link";
import { DoorOpen, UserMinus } from "lucide-react";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { noticePreviewAction, resignAction, withdrawResignationAction } from "@/app/(app)/org/exits/actions";
import type { Reason } from "./initiate-exit";
import { fmtDate } from "./exit-drawer";

type Notice = { policy: string | null; days: number; inProbation: boolean; lastWorkingDate: string };
export type MyExit = { id: string; status: "under_review" | "in_progress" | "exited" | "withdrawn" | "rejected"; resignation_date: string; last_working_date: string; reason: string | null; comments: string | null };

/** S46: the employee resigns. Their notice period suggests the last day; they can ask for another one. */
export function ResignDialog({ reasons, today }: { reasons: Reason[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [noticeError, setNoticeError] = React.useState<string | null>(null);
  const [reasonId, setReasonId] = React.useState<string | undefined>();
  const [lwd, setLwd] = React.useState("");
  const [comments, setComments] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const shown = reasons.filter((r) => r.kind !== "termination");

  const onOpen = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setError(null); setReasonId(undefined); setComments(""); setNotice(null); setNoticeError(null);
    noticePreviewAction(null, today).then((r) => { if (r.ok) { setNotice(r.data!); setLwd(r.data!.lastWorkingDate); } else setNoticeError(r.error); });
  };
  const submit = () => start(async () => {
    setError(null);
    const r = await resignAction({ reasonId: reasonId ?? null, lastWorkingDate: lwd || null, comments: comments || null });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(r.data!.status === "in_progress" ? "Your resignation is recorded" : "Resignation sent", { description: r.data!.status === "in_progress" ? `Your last working day is ${fmtDate(r.data!.lastWorkingDate)}.` : "Your manager and HR will review it. You can withdraw it until then." });
    setOpen(false);
  });

  return (
    <Modal open={open} onOpenChange={onOpen} size="md" title="Resign" description="We're sorry to see you go. Your manager and HR will review this."
      trigger={<Button variant="secondary" size="sm"><UserMinus />Resign</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={pending} onClick={submit}>Submit resignation</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !["lastWorkingDate", "reasonId"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        {noticeError && <Banner tone="warning">{noticeError}</Banner>}
        <Banner tone="info">
          {notice ? (notice.policy
            ? <>Your notice period is <strong>{notice.days} days</strong>{notice.inProbation ? " while on probation" : ""}, so your last working day would be <strong>{fmtDate(notice.lastWorkingDate)}</strong>.</>
            : <>You don&apos;t have a notice period set. Pick the last day you&apos;d like to work.</>) : "Checking your notice period…"}
        </Banner>
        <Field label="Reason" error={error?.field === "reasonId" ? error.message : undefined}>
          <Select value={reasonId} onValueChange={setReasonId} placeholder="Pick a reason" options={shown.map((r) => ({ value: r.id, label: r.name }))} disabled={!shown.length} />
        </Field>
        <Field label="Last working day you'd like" help="HR may agree a different day with you." error={error?.field === "lastWorkingDate" ? error.message : undefined}>
          <Input type="date" min={today} value={lwd} onChange={(e) => setLwd(e.target.value)} />
        </Field>
        <Field label="Anything you'd like to add?" help="Shared with your manager and HR"><Textarea value={comments} onChange={(e) => setComments(e.target.value)} maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}

/** Where the person's own exit stands, with Withdraw while it's still under review. */
export function MyExitBanner({ exit }: { exit: MyExit }) {
  if (exit.status === "under_review") {
    return (
      <Banner tone="warning" title="Your resignation is under review"
        action={<ConfirmDialog title="Withdraw your resignation?" description="Your manager and HR will see that you've decided to stay. You can resign again later." confirmLabel="Withdraw" tone="primary"
          onConfirm={async () => { const r = await withdrawResignationAction(exit.id); if (r.ok) toast.success("Resignation withdrawn"); else toast.error(r.error); }}
          trigger={<Button variant="secondary" size="sm">Withdraw</Button>} />}>
        Sent on {fmtDate(exit.resignation_date)}. You asked for {fmtDate(exit.last_working_date)} as your last working day.
      </Banner>
    );
  }
  if (exit.status === "in_progress") return <Banner tone="info" title={`Your last working day is ${fmtDate(exit.last_working_date)}`}>Your resignation was accepted. Check your exit tasks and hand over your work before then.</Banner>;
  if (exit.status === "rejected") return <Banner tone="info" title="Your resignation was declined">Talk to your manager or HR if you have questions.</Banner>;
  if (exit.status === "withdrawn") return <Banner tone="success" title="Your resignation was withdrawn">Nothing changes. Glad you&apos;re staying.</Banner>;
  return null;
}

/** For HR looking at someone's profile: where their exit stands. */
export function ExitStatusBanner({ exit, name }: { exit: MyExit; name: string }) {
  if (exit.status !== "under_review" && exit.status !== "in_progress") return null;
  return (
    <Banner tone="warning" title={exit.status === "under_review" ? `${name} has resigned` : `${name} is serving notice`}
      action={<Button asChild variant="secondary" size="sm"><Link href="/org/exits"><DoorOpen />Open exits</Link></Button>}>
      {exit.status === "under_review" ? `Resigned on ${fmtDate(exit.resignation_date)}. Waiting for approval.` : `Last working day: ${fmtDate(exit.last_working_date)}.`}
    </Banner>
  );
}
