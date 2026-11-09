/**
 * Excel import of payroll inputs (pure checks, no I/O): the kinds a sheet may carry, how a row is read, and the
 * key that makes re-uploading the same file harmless.
 */
import { createHash } from "node:crypto";

export const IMPORT_KINDS = [
  { kind: "bonus", label: "Bonus", takes: "amount" },
  { kind: "adhoc_earning", label: "One-time payment", takes: "amount" },
  { kind: "adhoc_deduction", label: "One-time deduction", takes: "amount" },
  { kind: "arrear", label: "Arrears", takes: "amount" },
  { kind: "overtime", label: "Overtime", takes: "amount" },
  { kind: "shift_allowance", label: "Shift allowance", takes: "amount" },
  { kind: "leave_encashment", label: "Leave encashment", takes: "amount_or_days" },
  { kind: "payable_units", label: "Payable units (daily wage / piece rate)", takes: "days" },
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number]["kind"];
export const IMPORT_HEADERS = ["Employee number", "Name", "Kind", "Amount", "Days or units", "Note", "Component code"] as const;

const KIND_BY_LABEL = new Map<string, ImportKind>(IMPORT_KINDS.flatMap((k) => [[k.label.toLowerCase(), k.kind], [k.kind, k.kind], [k.kind.replace(/_/g, " "), k.kind]]));
/** "Bonus", "bonus", "adhoc earning" → the kind; null when unknown. */
export const kindFromCell = (v: unknown): ImportKind | null => KIND_BY_LABEL.get(String(v ?? "").trim().toLowerCase()) ?? null;

export type ImportRow = { rowNumber: number; employee: string; kind: ImportKind | null; amountPaise: number | null; days: number | null; note: string | null; component: string | null };

/** Units / days from a cell: whole, half or hundredths, 0 < n ≤ 999.99. */
export function cellToUnits(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 999.99) return null;
  return Math.round(n * 100) / 100;
}

/** Problems with one row (empty list = fine). Days-based kinds need days; amount kinds need an amount. */
export function rowProblems(r: ImportRow, opts: { unitWorker: boolean | null }): string[] {
  const out: string[] = [];
  if (!r.employee) out.push("Employee number is empty.");
  if (!r.kind) out.push(`Kind must be one of: ${IMPORT_KINDS.map((k) => k.label).join(", ")}.`);
  const def = IMPORT_KINDS.find((k) => k.kind === r.kind);
  if (def?.takes === "amount" && !(r.amountPaise && r.amountPaise > 0)) out.push("Amount must be rupees above zero, like 5000.");
  if (def?.takes === "days" && !(r.days && r.days > 0)) out.push("Days or units must be above zero.");
  if (def?.takes === "amount_or_days" && !(r.amountPaise && r.amountPaise > 0) && !(r.days && r.days > 0)) out.push("Enter an amount or the days to encash.");
  if (r.kind === "payable_units" && opts.unitWorker === false) out.push("Payable units are only for daily-wage or piece-rate workers (worker type on the profile).");
  if (r.kind === "payable_units" && r.days && r.days > 744) out.push("Units can't be more than 744 in a month.");
  if (r.note && r.note.length > 200) out.push("Keep the note under 200 characters.");
  return out;
}

/** Stable key for a row: the same person, kind, amount, days, note and component in the same run month are one input. */
export function importKey(a: { payGroupId: string; month: string; employeeId: string; kind: string; amountPaise: number | null; days: number | null; note: string | null; componentId: string | null }) {
  return createHash("sha256").update([a.payGroupId, a.month, a.employeeId, a.kind, a.amountPaise ?? "", a.days ?? "", (a.note ?? "").trim(), a.componentId ?? ""].join("|")).digest("hex").slice(0, 32);
}
