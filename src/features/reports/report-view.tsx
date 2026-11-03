"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, FileSpreadsheet, Inbox } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { cell, type ColType } from "@/server/modules/reports/rules";

export type Header = { key: string; label: string; type: ColType };
export type FilterDef = { key: string; label: string; type: "date_range" | "select" | "month"; options?: { value: string; label: string }[] };
const MAX_SHOWN = 500;

/** A report's rows as a table, with its filters in the URL (so a link reproduces it) and CSV / XLSX downloads. */
export function ReportTable({ headers, rows, note, limitNote }: { headers: Header[]; rows: Record<string, unknown>[]; note?: string; limitNote?: boolean }) {
  const shown = rows.slice(0, MAX_SHOWN);
  const render = (h: Header, v: unknown) => {
    if (h.key === "link" && typeof v === "string") return <Link href={v} className="text-accent-text hover:underline">Open</Link>;
    const s = cell(h.type, v);
    if (h.type === "money" && s) return Number(s).toLocaleString("en-IN", { minimumFractionDigits: 2 });
    return s || "–";
  };
  return (
    <div className="flex flex-col gap-3">
      {note && <Banner tone="info">{note}</Banner>}
      {rows.length === 0 ? <Card><EmptyState compact icon={<Inbox />} title="No rows for these filters" description="Try a wider period or fewer filters." /></Card> : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Report rows</caption>
              <thead className="sticky top-0 z-10 bg-surface-sunken text-text-muted">
                <tr>{headers.map((h) => <th key={h.key} scope="col" className={"whitespace-nowrap px-3 py-2 font-medium " + (h.type === "number" || h.type === "money" ? "text-right" : "text-left")}>{h.label}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {headers.map((h) => <td key={h.key} className={"whitespace-nowrap px-3 py-1.5 " + (h.type === "number" || h.type === "money" ? "text-right tabular" : "")}>{render(h, r[h.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-3 py-2 text-xs text-text-muted">{rows.length.toLocaleString("en-IN")} {rows.length === 1 ? "row" : "rows"}{rows.length > MAX_SHOWN ? ` · showing the first ${MAX_SHOWN}; export for everything` : ""}{limitNote ? " · custom reports return at most 5,000 rows" : ""}</p>
        </div>
      )}
    </div>
  );
}

/** S182 detail: one standard report with its filter bar. */
export function StandardReport({ reportKey, name, description, filters, options, params, headers, rows, note }: {
  reportKey: string; name: string; description: string; filters: FilterDef[]; options: Record<string, { value: string; label: string }[]>; params: Record<string, string>; headers: Header[]; rows: Record<string, unknown>[]; note?: string;
}) {
  const router = useRouter();
  const [f, setF] = React.useState<Record<string, string>>(params);
  const qs = (x: Record<string, string>) => new URLSearchParams(Object.entries(x).filter(([, v]) => v)).toString();
  const exportHref = (format: "csv" | "xlsx") => `/reports/export?${qs({ key: reportKey, format, ...params })}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/reports"><ArrowLeft />All reports</Link></Button>
        <div className="ml-auto flex gap-2">
          <Button asChild variant="secondary" size="sm"><a href={exportHref("csv")} download><Download />CSV</a></Button>
          <Button asChild size="sm"><a href={exportHref("xlsx")} download><FileSpreadsheet />XLSX</a></Button>
        </div>
      </div>
      <Card className="p-4">
        <form className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end" onSubmit={(e) => { e.preventDefault(); router.push(`/reports/${reportKey}?${qs(f)}`); }}>
          {filters.map((fd) => fd.type === "date_range" ? (
            <React.Fragment key={fd.key}>
              <Field label="From" className="sm:w-40"><Input type="date" value={f.from ?? ""} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
              <Field label="To" className="sm:w-40"><Input type="date" value={f.to ?? ""} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
            </React.Fragment>
          ) : (
            <Field key={fd.key} label={fd.label} className="sm:w-52">
              <Select value={f[fd.key] || "__all"} onValueChange={(v) => setF({ ...f, [fd.key]: v === "__all" ? "" : v })} options={[{ value: "__all", label: "All" }, ...(options[fd.key] ?? [])]} />
            </Field>
          ))}
          {filters.length > 0 && <Button type="submit" variant="secondary">Show</Button>}
        </form>
        <p className="mt-3 text-sm text-text-muted">{description} Only people you may see are included.</p>
      </Card>
      <ReportTable headers={headers} rows={rows} note={note} />
      <span className="sr-only">{name}</span>
    </div>
  );
}
