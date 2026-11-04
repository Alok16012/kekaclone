"use client";
import * as React from "react";
import { Paperclip, ScanLine, X } from "lucide-react";
import { Modal } from "@/ui/overlay";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { addExpenseAction, readReceiptAction, updateExpenseAction } from "@/app/(app)/me/expenses/actions";
import { currencyName } from "@/server/modules/expenses/fx-rules";
import { CATEGORY_KINDS, inr, mileagePaise, parseHalfDays, parseKm, perDiemPaise, RECEIPT_ACCEPT, RECEIPT_LABEL, rupeesText, MAX_RECEIPTS, type Category } from "@/server/modules/expenses/rules";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import type { ExpenseRow } from "@/server/modules/expenses/service";

const describe = (c: Category) => {
  const bits: string[] = [];
  if (c.kind === "mileage" && c.rate_per_km_paise) bits.push(`${inr(c.rate_per_km_paise)} per km`);
  if (c.kind === "per_diem" && c.limit_paise) bits.push(`${inr(c.limit_paise)} per day`);
  else if (c.limit_paise && c.limit_period) bits.push(`Limit ${inr(c.limit_paise)} ${c.limit_period === "claim" ? "per claim" : `a ${c.limit_period}`}`);
  if (c.receipt_required_above_paise != null) bits.push(c.receipt_required_above_paise === 0 ? "Receipt always needed" : `Receipt needed above ${inr(c.receipt_required_above_paise)}`);
  return bits.join(" · ") || CATEGORY_KINDS.find((k) => k.value === c.kind)?.hint;
};

/** Add or edit one expense. Mileage and per diem work the amount out as you type; the server does the same sum in paise. */
export function ExpenseDialog({ open, onOpenChange, categories, expense, claimId, today, currencies = [], ocr }: {
  open: boolean; onOpenChange: (o: boolean) => void; categories: Category[]; expense?: ExpenseRow | null; claimId?: string | null; today: string;
  /** currencies finance has rates for (besides INR) */ currencies?: string[]; ocr?: { configured: boolean; reason?: string };
}) {
  const [categoryId, setCategoryId] = React.useState(expense?.category_id ?? "");
  const [currency, setCurrency] = React.useState(expense?.currency ?? "INR");
  const [amount, setAmount] = React.useState(expense ? rupeesText(expense.foreign_amount_paise ?? expense.amount_paise) : "");
  const [spentOn, setSpentOn] = React.useState(expense?.spent_on ?? today);
  const [merchant, setMerchant] = React.useState(expense?.merchant ?? "");
  const [scan, setScan] = React.useState<{ busy: boolean; note: string | null; tone: "info" | "warning" | "success" }>({ busy: false, note: null, tone: "info" });
  const readReceipt = (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !ocr?.configured || !/^image\/(png|jpeg)$/.test(f.type) || expense) return;
    const fd = new FormData(); fd.set("receipt", f);
    setScan({ busy: true, note: "Reading the receipt…", tone: "info" });
    readReceiptAction(fd).then((r) => {
      if (!r.ok) { setScan({ busy: false, note: r.error, tone: "warning" }); return; }
      const g = r.data!.guess;
      const filled: string[] = [];
      if (g.amountPaise && !amount) { setAmount(rupeesText(g.amountPaise)); filled.push(`amount ${inr(g.amountPaise)} (${g.confidence.amount}% sure)`); }
      if (g.date && g.date <= today) { setSpentOn(g.date); filled.push(`date ${g.date} (${g.confidence.date}% sure)`); }
      if (g.merchant && !merchant) { setMerchant(g.merchant); filled.push(`merchant "${g.merchant}" (${g.confidence.merchant}% sure)`); }
      setScan({ busy: false, tone: filled.length ? "success" : "warning", note: filled.length ? `Read from the receipt: ${filled.join(", ")}. Check and change anything that's wrong.` : "Nothing useful could be read from the receipt. Type the details in." });
    });
  };
  const [distance, setDistance] = React.useState(expense?.km_h != null ? rupeesText(expense.km_h) : "");
  const [days, setDays] = React.useState(expense?.half_days != null ? String(expense.half_days / 2) : "");
  const [remove, setRemove] = React.useState<string[]>([]);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const cat = categories.find((c) => c.id === categoryId);
  const kind = cat?.kind;
  const computed = kind === "mileage" ? (parseKm(distance) != null ? mileagePaise(parseKm(distance)!, cat!.rate_per_km_paise ?? 0) : null)
    : kind === "per_diem" ? (parseHalfDays(days) != null ? perDiemPaise(parseHalfDays(days)!, cat!.limit_paise ?? 0) : null) : null;
  const err = (f: string) => (error?.field === f ? error.message : undefined);

  const save = () => start(async () => {
    setError(null);
    const fd = new FormData(form.current!);
    if (!categoryId) { setError({ message: "Pick a category.", field: "categoryId" }); return; }
    const files = fd.getAll("receipts").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) { setError({ message: "Each receipt must be 5 MB or smaller.", field: "receipts" }); return; }
    if (files.length + (expense?.receipts.length ?? 0) - remove.length > MAX_RECEIPTS) { setError({ message: `Attach up to ${MAX_RECEIPTS} receipts.`, field: "receipts" }); return; }
    fd.set("categoryId", categoryId); fd.set("kind", kind ?? "");
    if (claimId) fd.set("claimId", claimId);
    if (expense) { fd.set("id", expense.id); for (const r of remove) fd.append("removeReceipt", r); }
    const r = expense ? await updateExpenseAction(fd) : await addExpenseAction(fd);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    const flags = (r.data as { violations?: string[] } | undefined)?.violations ?? [];
    if (flags.length) toast.warning(expense ? "Saved, with policy flags" : "Expense added, with policy flags", { description: "Check the notes under the expense before you send the claim." });
    else toast.success(expense ? "Expense updated" : "Expense added");
    onOpenChange(false);
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={expense ? "Edit expense" : "Add an expense"} description="Keep the receipt: you can attach a photo or PDF of it here."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={pending} onClick={save}>{expense ? "Save" : "Add expense"}</Button></>}>
      <form ref={form} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Category" required error={err("categoryId")} help={cat ? describe(cat) : undefined}>
          <Select value={categoryId} onValueChange={setCategoryId} placeholder="Choose a category" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" required error={err("spentOn")}><Input type="date" name="spentOn" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} max={today} required /></Field>
          {kind === "mileage" ? (
            <Field label="Distance (km)" required error={err("distance")} help={computed != null ? `Amount: ${inr(computed)}` : undefined}>
              <Input name="distance" inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} placeholder="e.g. 12.5" />
            </Field>
          ) : kind === "per_diem" ? (
            <Field label="Days" required error={err("days")} help={computed != null ? `Amount: ${inr(computed)}` : "Half days are fine, e.g. 1.5"}>
              <Input name="days" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 2" />
            </Field>
          ) : (
            <Field label={currency === "INR" ? "Amount (₹)" : `Amount (${currency})`} required error={err("amount") ?? err("currency")} help={currency !== "INR" ? "Converted to rupees at the rate finance set for that date; limits apply to the rupee amount." : undefined}>
              <Input name="amount" inputMode="decimal" leading={<span className="text-sm">{currency === "INR" ? "₹" : currency}</span>} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="tabular" />
            </Field>
          )}
        </div>
        {currencies.length > 0 && kind !== "mileage" && kind !== "per_diem" && (
          <Field label="Currency" help="Spent abroad? Pick the currency on the receipt.">
            <Select value={currency} onValueChange={setCurrency} options={["INR", ...currencies.filter((c) => c !== "INR")].map((c) => ({ value: c, label: `${c} · ${currencyName(c)}` }))} />
            <input type="hidden" name="currency" value={currency} />
          </Field>
        )}
        {expense?.foreign_amount_paise != null && expense.fx_rate && <p className="text-sm text-text-muted">Recorded as {inr(expense.amount_paise)} at {Number(expense.fx_rate).toLocaleString("en-IN", { maximumFractionDigits: 6 })} per {expense.currency}.</p>}
        <Field label={kind === "mileage" ? "Vehicle or route" : "Merchant"} help="Optional"><Input name="merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={120} /></Field>
        <Field label="What was it for?" help="Optional"><Textarea name="description" defaultValue={expense?.description ?? ""} maxLength={1000} rows={2} /></Field>
        {expense && expense.receipts.length > 0 && (
          <div>
            <p className="mb-1.5 text-sm font-medium">Attached receipts</p>
            <ul className="flex flex-col gap-1.5">
              {expense.receipts.map((f) => {
                const gone = remove.includes(f.id);
                return (
                  <li key={f.id} className="flex items-center gap-2 text-base">
                    <Paperclip aria-hidden className="size-4 text-text-muted" />
                    <span className={gone ? "truncate text-text-muted line-through" : "truncate"}>{f.name}</span>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setRemove((r) => (gone ? r.filter((x) => x !== f.id) : [...r, f.id]))}>
                      {gone ? "Keep" : <><X />Remove</>}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <Field label={expense?.receipts.length ? "Add receipts" : "Receipts"} help={`${RECEIPT_LABEL}.${ocr?.configured && !expense ? " A PNG or JPG receipt is read to fill in the amount, date and merchant for you to check." : ""}`} error={err("receipts")}>
          <Input name="receipts" type="file" accept={RECEIPT_ACCEPT} multiple className="py-1.5" onChange={(e) => readReceipt(e.target.files)} />
        </Field>
        {scan.note && <p className={`flex items-start gap-1.5 text-sm ${scan.tone === "warning" ? "text-warning-text" : scan.tone === "success" ? "text-success-text" : "text-text-muted"}`} aria-live="polite"><ScanLine aria-hidden className="mt-0.5 size-3.5 shrink-0" />{scan.note}</p>}
        {ocr && !ocr.configured && !expense && <p className="text-xs text-text-muted">Receipt reading is off: {ocr.reason}</p>}
      </form>
    </Modal>
  );
}
