"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bold, Braces, CheckCircle2, CircleDot, Clock3, Italic, List, ListOrdered, MinusCircle, PauseCircle, Send, Star, Underline, XCircle, Heading2 } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Popover } from "@/ui/overlay";
import { cn } from "@/lib/cn";
import { sanitizeHtml } from "@/server/modules/documents/rules";
import { groupLabel, offerStatusLabel, type StageGroup } from "@/server/modules/hire/rules";

export type HireTabs = { jobs: boolean; candidates: boolean; requisitions: boolean; offers: boolean; interviews: boolean; reports: boolean; settings: boolean };

/** Sub-navigation shared by the hiring pages (horizontal, scrolls on phones). */
export function HireNav({ show }: { show: HireTabs }) {
  const path = usePathname();
  const items = [
    { href: "/hire/jobs", label: "Jobs", on: show.jobs },
    { href: "/hire/candidates", label: "Candidates", on: show.candidates },
    { href: "/hire/requisitions", label: "Requisitions", on: show.requisitions },
    { href: "/hire/offers", label: "Offers & joining", on: show.offers },
    { href: "/hire/interviews", label: "My interviews", on: show.interviews },
    { href: "/hire/reports", label: "Reports", on: show.reports },
    { href: "/settings/hire", label: "Settings", on: show.settings },
  ].filter((i) => i.on);
  return (
    <nav aria-label="Hiring" className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {items.map((i) => {
        const active = path === i.href || path.startsWith(i.href + "/");
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("-mb-px inline-flex h-10 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-base font-medium text-text-muted hover:text-text", active && "border-accent text-text")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

const GROUP_TONE: Record<StageGroup, "neutral" | "accent" | "warning" | "success" | "danger"> = { sourced: "neutral", screening: "accent", interview: "accent", offer: "warning", hired: "success", rejected: "danger" };
export function StageBadge({ group, label }: { group: StageGroup; label?: string }) {
  return <Badge tone={GROUP_TONE[group] ?? "neutral"}><CircleDot aria-hidden />{label ?? groupLabel(group)}</Badge>;
}

const OFFER_TONE: Record<string, { tone: "neutral" | "accent" | "warning" | "success" | "danger"; Icon: React.ComponentType<{ className?: string }> }> = {
  draft: { tone: "neutral", Icon: MinusCircle }, pending_approval: { tone: "warning", Icon: Clock3 }, released: { tone: "accent", Icon: Send },
  accepted: { tone: "success", Icon: CheckCircle2 }, declined: { tone: "danger", Icon: XCircle }, revised: { tone: "neutral", Icon: MinusCircle },
  withdrawn: { tone: "neutral", Icon: MinusCircle }, expired: { tone: "danger", Icon: Clock3 },
};
export function OfferBadge({ status, approval }: { status: string; approval?: string | null }) {
  const s = OFFER_TONE[status] ?? OFFER_TONE.draft;
  const label = status === "draft" && approval === "approved" ? "Approved, ready to send" : status === "draft" && approval === "rejected" ? "Declined by approver" : offerStatusLabel(status);
  return <Badge tone={status === "draft" && approval === "approved" ? "accent" : s.tone}><s.Icon aria-hidden />{label}</Badge>;
}

const JOB_TONE: Record<string, { tone: "neutral" | "success" | "warning"; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  draft: { tone: "neutral", label: "Draft", Icon: MinusCircle }, open: { tone: "success", label: "Open", Icon: CheckCircle2 },
  on_hold: { tone: "warning", label: "On hold", Icon: PauseCircle }, closed: { tone: "neutral", label: "Closed", Icon: XCircle },
};
export function JobStatusBadge({ status }: { status: string }) {
  const s = JOB_TONE[status] ?? JOB_TONE.draft;
  return <Badge tone={s.tone}><s.Icon aria-hidden />{s.label}</Badge>;
}

export function Rating({ value, count }: { value: number | null; count?: number }) {
  if (value == null) return <span className="text-sm text-text-muted">Not rated</span>;
  return (
    <span className="inline-flex items-center gap-1 text-sm font-medium tabular" aria-label={`Average rating ${value}${count ? ` from ${count} scorecards` : ""}`}>
      <Star aria-hidden className="size-3.5 fill-current text-warning-text" />{value.toFixed(1)}{count ? <span className="font-normal text-text-muted">({count})</span> : null}
    </span>
  );
}

export const inr0 = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
export const lpa = (paise: number) => `${(paise / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 1 })} LPA`;
export const day = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d.length === 10 ? d + "T00:00:00+05:30" : d) : d;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};
export const when = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
export const fullName = (first: string, last: string | null | undefined) => [first, last].filter(Boolean).join(" ");

export const PROSE = "[&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc";

/** Small rich-text editor: bold, italic, underline, a heading and lists, plus an optional field picker. Output is sanitised on save. */
export function RichText({ initial, onChange, label, placeholders, minHeight = "min-h-48" }: {
  initial: string; onChange: (html: string) => void; label: string; placeholders?: readonly { key: string; label: string }[]; minHeight?: string;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const range = React.useRef<Range | null>(null);
  const first = React.useRef(initial);
  const id = React.useId();
  const attach = React.useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    if (el && !el.dataset.ready) { el.innerHTML = sanitizeHtml(first.current); el.dataset.ready = "1"; }
  }, []);
  const keep = () => { const s = window.getSelection(); if (s?.rangeCount && ref.current?.contains(s.anchorNode)) range.current = s.getRangeAt(0).cloneRange(); };
  const sync = () => { if (ref.current) onChange(ref.current.innerHTML); };
  const run = (cmd: string, value?: string) => {
    const el = ref.current; if (!el) return;
    el.focus();
    if (range.current) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(range.current); }
    document.execCommand(cmd, false, value);   // the browser's built-in editing keeps undo working
    keep(); sync();
  };
  const tool = (l: string, icon: React.ReactNode, cmd: string, v?: string) => <IconButton type="button" size="icon-sm" label={l} onMouseDown={(e) => e.preventDefault()} onClick={() => run(cmd, v)}>{icon}</IconButton>;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id={`${id}-l`}>{label}</span>
      <div className="overflow-hidden rounded-md border border-border-input focus-within:border-focus focus-within:ring-3 focus-within:ring-focus/25">
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface-sunken px-1.5 py-1">
          {tool("Bold", <Bold />, "bold")}{tool("Italic", <Italic />, "italic")}{tool("Underline", <Underline />, "underline")}
          <span aria-hidden className="mx-1 h-5 w-px bg-border" />
          {tool("Heading", <Heading2 />, "formatBlock", "h3")}{tool("Bulleted list", <List />, "insertUnorderedList")}{tool("Numbered list", <ListOrdered />, "insertOrderedList")}
          {placeholders && (
            <Popover align="start" className="w-72 p-1" trigger={<Button type="button" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()}><Braces />Insert field</Button>}>
              <ul className="max-h-72 overflow-y-auto">
                {placeholders.map((p) => (
                  <li key={p.key}>
                    <button type="button" className="flex w-full flex-col rounded-sm px-2.5 py-1.5 text-left hover:bg-surface-hover focus-visible:bg-surface-hover" onClick={() => run("insertText", `{{${p.key}}}`)}>
                      <span className="text-base">{p.label}</span><span className="font-mono text-xs text-text-muted">{`{{${p.key}}}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Popover>
          )}
        </div>
        <div ref={attach} role="textbox" aria-multiline aria-labelledby={`${id}-l`} contentEditable suppressContentEditableWarning onInput={sync} onKeyUp={keep} onMouseUp={keep} onBlur={keep}
          className={cn(minHeight, "max-h-[50vh] overflow-y-auto bg-surface px-3 py-2 text-base outline-none", PROSE)} />
      </div>
    </div>
  );
}

export function Html({ html, className }: { html: string; className?: string }) {
  return <div className={cn("text-base", PROSE, className)} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}
