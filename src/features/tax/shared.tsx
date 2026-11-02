"use client";
import * as React from "react";
import { CheckCircle2, Clock3, MinusCircle, XCircle, CircleDot } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Input } from "@/ui/field";
import { cn } from "@/lib/cn";
import { inr, parseRupees } from "@/server/modules/tax/rules";

export const Money = ({ paise, className }: { paise: number; className?: string }) => <span className={cn("tabular", className)}>{inr(paise)}</span>;
export const shortDate = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const monthName = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

const PROOF: Record<string, { tone: "neutral" | "warning" | "success" | "danger" | "accent"; label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  not_submitted: { tone: "neutral", label: "No proof yet", Icon: MinusCircle },
  submitted: { tone: "warning", label: "Waiting for check", Icon: Clock3 },
  accepted: { tone: "success", label: "Accepted", Icon: CheckCircle2 },
  partially_accepted: { tone: "accent", label: "Partly accepted", Icon: CircleDot },
  rejected: { tone: "danger", label: "Rejected", Icon: XCircle },
};
/** Proof status as icon + words (never colour alone). */
export function ProofStatus({ status }: { status: string }) {
  const s = PROOF[status] ?? PROOF.not_submitted;
  return <Badge tone={s.tone}><s.Icon aria-hidden />{s.label}</Badge>;
}

/** Rupee text input: keeps what was typed, the caller parses it to paise on save (never via floats). */
export function RupeeInput({ value, onChange, ...props }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return <Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={value} onChange={(e) => onChange(e.target.value)} className="tabular" {...props} />;
}
export const paiseText = (p: number | null | undefined) => (p ? (p % 100 ? (p / 100).toFixed(2) : String(p / 100)) : "");
export const toPaise = (v: string) => parseRupees(v);
