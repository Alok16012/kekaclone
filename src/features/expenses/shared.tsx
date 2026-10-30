"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock3, FileText, MinusCircle, Paperclip, Wallet, XCircle } from "lucide-react";
import { Badge } from "@/ui/badge";
import { ApprovalTimeline } from "@/ui/flow";
import { cn } from "@/lib/cn";
import { inr, isBlocking, kmLabel, monthLabel } from "@/server/modules/expenses/rules";
import type { claimDetail, ExpenseRow } from "@/server/modules/expenses/service";

export type ClaimDetail = NonNullable<Awaited<ReturnType<typeof claimDetail>>>;

const CLAIM: Record<string, { tone: "neutral" | "warning" | "success" | "danger" | "accent"; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  draft: { tone: "neutral", label: "Draft", Icon: MinusCircle },
  submitted: { tone: "warning", label: "In review", Icon: Clock3 },
  approved: { tone: "accent", label: "Approved, to be paid", Icon: CheckCircle2 },
  rejected: { tone: "danger", label: "Declined", Icon: XCircle },
  paid: { tone: "success", label: "Paid", Icon: Wallet },
  // advances
  pending: { tone: "warning", label: "Waiting for approval", Icon: Clock3 },
  settled: { tone: "success", label: "Settled", Icon: CheckCircle2 },
};
const ADVANCE_LABEL: Record<string, string> = { approved: "Approved, to be paid", paid: "Received", rejected: "Declined" };

/** Status is never colour alone: icon + words. */
export function ClaimStatus({ status, advance }: { status: string; advance?: boolean }) {
  const s = CLAIM[status] ?? CLAIM.draft;
  return <Badge tone={s.tone}><s.Icon aria-hidden />{(advance && ADVANCE_LABEL[status]) || s.label}</Badge>;
}

export const Money = ({ paise, className }: { paise: number; className?: string }) => <span className={cn("tabular", className)}>{inr(paise)}</span>;
export const shortDate = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined);

export function Flags({ texts, codes }: { texts: string[]; codes: string[] }) {
  if (!texts.length) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {texts.map((t, i) => (
        <li key={i} className={cn("flex items-start gap-1.5 text-sm", isBlocking(codes[i]) ? "text-danger-text" : "text-warning-text")}>
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function Receipts({ files }: { files: ExpenseRow["receipts"] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.id}>
          <a href={`/expenses/receipts/${f.id}`} target="_blank" rel="noopener" className="inline-flex max-w-56 items-center gap-1 rounded-sm bg-surface-sunken px-2 py-0.5 text-sm text-accent-text hover:underline">
            {f.mime === "application/pdf" ? <FileText aria-hidden className="size-3.5 shrink-0" /> : <Paperclip aria-hidden className="size-3.5 shrink-0" />}
            <span className="truncate">{f.name}</span><span className="sr-only">(opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function lineDetail(x: ExpenseRow) {
  return [x.km_h != null ? kmLabel(x.km_h) : null, x.half_days != null ? `${x.half_days / 2} ${x.half_days === 2 ? "day" : "days"}` : null, x.merchant].filter(Boolean).join(" · ");
}

/** One expense line: category, date, what it was, amount, receipts and policy flags. `actions` sits on the right. */
export function ExpenseLine({ x, actions, leading }: { x: ExpenseRow; actions?: React.ReactNode; leading?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-base font-medium">{x.category}<span className="ml-2 text-sm font-normal text-text-muted">{shortDate(x.spent_on)}</span></p>
          <Money paise={x.amount_paise} className="text-base font-medium" />
        </div>
        {(lineDetail(x) || x.description) && <p className="text-sm text-text-muted">{[lineDetail(x), x.description].filter(Boolean).join(" — ")}</p>}
        <Receipts files={x.receipts} />
        <Flags texts={x.violation_text} codes={x.violations} />
      </div>
      {actions}
    </li>
  );
}

/** Read-only claim view used in the inbox, the expense desk and payouts. */
export function ClaimBody({ d }: { d: ClaimDetail }) {
  const flags = d.items.reduce((s, i) => s + i.violations.length, 0);
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Claim</dt><dd className="font-medium">#{d.claim.number} · {d.claim.title}</dd></div>
        <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-0.5"><ClaimStatus status={d.claim.status} /></dd></div>
        <div><dt className="text-sm text-text-muted">Total</dt><dd className="font-medium"><Money paise={d.claim.total_paise} /></dd></div>
        <div><dt className="text-sm text-text-muted">To pay</dt><dd className="font-medium"><Money paise={d.claim.payable_paise} /></dd></div>
        {d.advance && (
          <div className="col-span-2"><dt className="text-sm text-text-muted">Advance</dt>
            <dd>{d.advance.purpose} · <Money paise={d.advance.amount_paise} />{d.claim.advance_applied_paise > 0 ? <> · <Money paise={d.claim.advance_applied_paise} /> used by this claim</> : <> · <Money paise={d.advance.outstanding_paise} /> still open</>}</dd></div>
        )}
        {d.payoutLabel && <div className="col-span-2"><dt className="text-sm text-text-muted">Payment</dt><dd>{d.payoutLabel}</dd></div>}
        {d.claim.payout_month && d.claim.status === "approved" && !d.payoutLabel && <div className="col-span-2"><dt className="text-sm text-text-muted">Payment</dt><dd>In {monthLabel(d.claim.payout_month)} payroll</dd></div>}
      </dl>
      {flags > 0 && <p className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text"><AlertTriangle aria-hidden className="size-4" />{flags} policy {flags === 1 ? "flag" : "flags"} to look at</p>}
      <div>
        <h3 className="mb-1 text-sm font-semibold">Expenses ({d.items.length})</h3>
        <ul className="-mx-5 divide-y divide-border border-y border-border">{d.items.map((x) => <ExpenseLine key={x.id} x={x} />)}</ul>
      </div>
      {d.steps.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
          <ApprovalTimeline levels={d.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: at(s.acted_at) }))} />
        </div>
      )}
    </div>
  );
}

export function DeskNav({ show }: { show: { approvals: boolean; payouts: boolean; reports: boolean } }) {
  const items = [
    show.approvals && { href: "/expenses/approvals", label: "Approvals" },
    show.payouts && { href: "/expenses/payouts", label: "Payouts" },
    show.reports && { href: "/expenses/reports", label: "Reports" },
  ].filter(Boolean) as { href: string; label: string }[];
  return <DeskLinks items={items} />;
}

function DeskLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  if (items.length < 2) return null;
  return (
    <nav aria-label="Expense desk" className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path === i.href ? "page" : undefined}
          className={cn("-mb-px inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-3 text-base font-medium text-text-muted hover:text-text", path === i.href && "border-accent text-text")}>{i.label}</Link>
      ))}
    </nav>
  );
}
