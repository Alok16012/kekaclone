"use client";
import * as React from "react";
import { Field, Textarea } from "@/ui/field";
import { DetailSkeleton, LoanFacts, LoanSteps, useLoanDetail } from "./shared";

/** Inbox pane for a loan request: amount, terms, estimated EMI and interest, the approval chain so far. */
export function LoanRequestDetail({ id, comment, onComment }: { id: string; comment: string; onComment: (v: string) => void }) {
  const s = useLoanDetail(id);
  if (!s) return <DetailSkeleton />;
  if (s.error || !s.d) return <p className="text-base text-danger-text">{s.error ?? "Couldn't load this request."}</p>;
  return (
    <div className="flex flex-col gap-5">
      <LoanFacts d={s.d} />
      <LoanSteps d={s.d} />
      <Field label="Comment" help="Shared with the requester"><Textarea value={comment} onChange={(e) => onComment(e.target.value)} maxLength={1000} /></Field>
    </div>
  );
}
