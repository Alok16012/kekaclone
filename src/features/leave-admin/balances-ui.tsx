"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, FileSpreadsheet, History, RefreshCw, Search, SlidersHorizontal, Upload, Users, XCircle } from "lucide-react";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { Select } from "@/ui/select";
import { Drawer, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { DataTable, type Column } from "@/ui/table";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import {
  adjustBalanceAction, commitBalanceImportAction, ledgerAction, previewBalanceImportAction, runAccrualNowAction,
} from "@/app/(app)/settings/leave/actions";
import { LEDGER_LABEL, fmtDate, fmtNum } from "./labels";

type Cell = { typeId: string; available: number | null; credited: number; used: number; pending: number };
export type BalanceRow = { id: string; name: string; number: string; department: string | null; plan: string | null; cycleStart: string | null; cells: Cell[] };
type LeaveTypeCol = { id: string; name: string; code: string; color: string; kind: string };

export function BalancesAdmin({ rows, types, q, canRunAccrual }: { rows: BalanceRow[]; types: LeaveTypeCol[]; q: string; canRunAccrual: boolean }) {
  const router = useRouter();
  const [term, setTerm] = React.useState(q);
  const [adjusting, setAdjusting] = React.useState<BalanceRow | null>(null);
  const [history, setHistory] = React.useState<BalanceRow | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [searching, startSearch] = React.useTransition();
  const [running, startRun] = React.useTransition();
  const shown = types.filter((t) => rows.some((r) => r.cells.some((c) => c.typeId === t.id)));

  React.useEffect(() => {
    if (term.trim() === q) return;
    const t = setTimeout(() => startSearch(() => router.replace(term.trim() ? `?q=${encodeURIComponent(term.trim())}` : "?", { scroll: false })), 250);
    return () => clearTimeout(t);
  }, [term, q, router]);

  const columns: Column<BalanceRow>[] = [
    { key: "name", header: "Person", sortValue: (r) => r.name, cell: (r) => (
      <div className="min-w-36"><p className="font-medium">{r.name}</p><p className="text-sm text-text-muted">{r.number}{r.plan ? ` · ${r.plan}` : " · no leave plan"}</p></div>
    ) },
    { key: "dept", header: "Department", hideBelow: "lg", sortValue: (r) => r.department ?? "", cell: (r) => r.department ?? <span className="text-text-muted">—</span> },
    ...shown.map((t): Column<BalanceRow> => ({
      key: t.id, align: "right", header: <span className="inline-flex items-center gap-1.5" title={t.name}><span aria-hidden className="size-2 rounded-pill" style={{ background: t.color }} />{t.code}</span>,
      sortValue: (r) => r.cells.find((c) => c.typeId === t.id)?.available ?? -9999,
      cell: (r) => {
        const c = r.cells.find((x) => x.typeId === t.id);
        if (!c) return <span className="text-text-muted" aria-label="Not in plan">—</span>;
        if (c.available == null) return <span className="text-text-muted">No limit</span>;
        return <span className={cn("tabular", c.available < 0 && "text-danger-text font-medium")} title={`${t.name}: ${fmtNum(c.credited)} credited, ${fmtNum(c.used)} used, ${fmtNum(c.pending)} pending`}>{fmtNum(c.available)}</span>;
      },
    })),
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setHistory(r)} aria-label={`History for ${r.name}`}><History /><span className="hidden md:inline">History</span></Button>
        <Button size="sm" variant="secondary" disabled={!r.cells.length} onClick={() => setAdjusting(r)} aria-label={`Adjust balance for ${r.name}`}><SlidersHorizontal /><span className="hidden md:inline">Adjust</span></Button>
      </div>
    ) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="sm:max-w-xs sm:flex-1">
          <Input type="search" aria-label="Search people" placeholder="Search by name, number or email" value={term} onChange={(e) => setTerm(e.target.value)} leading={<Search />} />
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button asChild variant="secondary" size="sm"><a href="/settings/leave/balances/template" download><Download />Template</a></Button>
          <Button variant="secondary" size="sm" onClick={() => setImporting(true)}><Upload />Import balances</Button>
          {canRunAccrual && <Button variant="secondary" size="sm" loading={running} onClick={() => startRun(async () => {
            const r = await runAccrualNowAction();
            if (r.ok) toast.success(r.data!.posted ? `${r.data!.posted} credits posted (${fmtNum(r.data!.days)} days)` : "Everyone is up to date", { description: "Accruals also run every night." });
            else toast.error(r.error);
          })}><RefreshCw />Run accruals now</Button>}
        </div>
      </div>
      <p className="text-sm text-text-muted">Available days in each person’s current leave year (credited − used − pending). Hover a number for the breakdown.</p>
      <DataTable caption="Leave balances" rows={rows} columns={columns} rowKey={(r) => r.id} loading={searching}
        empty={<EmptyState compact icon={<Users />} title={q ? `No one matches “${q}”` : "No one to show"} description={q ? "Try another name or employee number." : "People you manage leave for appear here."} />} />
      {adjusting && <AdjustDialog row={adjusting} types={types} onClose={() => setAdjusting(null)} />}
      {history && <HistoryDrawer row={history} onClose={() => setHistory(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function AdjustDialog({ row, types, onClose }: { row: BalanceRow; types: LeaveTypeCol[]; onClose: () => void }) {
  const inPlan = row.cells.filter((c) => c.available != null).map((c) => ({ ...c, type: types.find((t) => t.id === c.typeId)! }));
  const [typeId, setTypeId] = React.useState(inPlan[0]?.typeId);
  const [dir, setDir] = React.useState<"add" | "remove">("add");
  const [days, setDays] = React.useState("1");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const cur = inPlan.find((c) => c.typeId === typeId);
  const amount = Number(days) * (dir === "add" ? 1 : -1);
  const save = () => start(async () => {
    const r = await adjustBalanceAction({ employeeId: row.id, leaveTypeId: typeId, amount, reason });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`${row.name}'s ${cur?.type.name ?? "balance"} updated`, { description: `${dir === "add" ? "Added" : "Removed"} ${days} ${Number(days) === 1 ? "day" : "days"}. They've been notified.` });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title="Adjust leave balance" description={row.name}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} disabled={!typeId}>Save adjustment</Button></>}>
      {inPlan.length === 0 ? <p className="text-base text-text-muted">{row.name}’s plan has no leave types with a balance.</p> : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label="Leave type"><Select value={typeId} onValueChange={setTypeId} options={inPlan.map((c) => ({ value: c.typeId, label: `${c.type.name} · ${fmtNum(c.available!)} available` }))} /></Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Change</span>
            <Segmented label="Add or remove days" value={dir} onChange={setDir} options={[{ value: "add", label: "Add days" }, { value: "remove", label: "Remove days" }]} />
          </div>
          <Field label="Days" help={cur && Number(days) > 0 ? `Balance becomes ${fmtNum(Math.round((cur.available! + amount) * 100) / 100)} days.` : "Up to 2 decimals, like 1 or 0.5."}>
            <Input type="number" inputMode="decimal" min={0.25} step={0.5} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="Reason" required help="Recorded in the leave ledger and shown to the person."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} placeholder="Worked on the Diwali weekend" /></Field>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

type LedgerData = { cycleStart: string; entries: { id: string; entry_date: string; kind: string; amount: number; note: string | null; type: string; color: string; by: string | null }[] };

function HistoryDrawer({ row, onClose }: { row: BalanceRow; onClose: () => void }) {
  const [data, setData] = React.useState<LedgerData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    ledgerAction(row.id).then((r) => { if (!live) return; if (r.ok) setData(r.data!); else setError(r.error); });
    return () => { live = false; };
  }, [row.id]);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={`${row.name}: leave history`} description={data ? `Leave year from ${fmtDate(data.cycleStart)}` : "Every credit and debit this leave year"}>
      {error ? <Banner tone="danger">{error}</Banner> : !data ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading history">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : data.entries.length === 0 ? (
        <EmptyState compact icon={<History />} title="Nothing yet this leave year" description="Credits, leave taken and adjustments will show up here." />
      ) : (
        <ul className="divide-y divide-border">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 py-3">
              <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-pill" style={{ background: e.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-base"><span className="font-medium">{LEDGER_LABEL[e.kind] ?? e.kind}</span> <span className="text-text-muted">· {e.type}</span></p>
                <p className="text-sm text-text-muted">{fmtDate(e.entry_date)}{e.note ? ` · ${e.note}` : ""}{e.by ? ` · by ${e.by}` : ""}</p>
              </div>
              <span className={cn("shrink-0 font-medium tabular", e.amount < 0 ? "text-danger-text" : e.amount > 0 ? "text-success-text" : "text-text-muted")}>{e.amount > 0 ? "+" : ""}{fmtNum(e.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

type Preview = { valid: boolean; total: number; ok: number; changes: number; results: { rowNumber: number; employee: string; name: string | null; type: string; balance: number | null; current: number | null; change: number | null; errors: string[] }[] };

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checking, startCheck] = React.useTransition();
  const [saving, startSave] = React.useTransition();
  const choose = (f: File | undefined) => {
    setError(null); setPreview(null); setFile(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setError("Choose an Excel .xlsx file."); return; }
    if (f.size > 5 * 1024 * 1024) { setError("The file is larger than 5 MB."); return; }
    setFile(f);
    const fd = new FormData(); fd.set("file", f);
    startCheck(async () => { const r = await previewBalanceImportAction(fd); if (r.ok) setPreview(r.data!); else setError(r.error); });
  };
  const commit = () => startSave(async () => {
    const fd = new FormData(); fd.set("file", file!);
    const r = await commitBalanceImportAction(fd);
    if (!r.ok) { setError(r.error); return; }
    toast.success(r.data!.changed ? `${r.data!.changed} ${r.data!.changed === 1 ? "balance" : "balances"} updated` : "Nothing to change", { description: "Each change is recorded as an opening balance entry." });
    onClose();
  });
  const bad = preview?.results.filter((r) => r.errors.length) ?? [];
  const changes = preview?.results.filter((r) => !r.errors.length && r.change) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Import opening balances" description="Set people's balances for this leave year from an Excel file."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={commit} loading={saving} disabled={!preview?.valid || checking}>{preview?.valid ? `Import ${preview.changes} ${preview.changes === 1 ? "change" : "changes"}` : "Import"}</Button></>}>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-base text-text-muted">
          <li><a href="/settings/leave/balances/template" download className="text-accent-text underline-offset-4 hover:underline">Download the template</a>. It lists everyone with today’s balances.</li>
          <li>Change the Balance column to what each person should have now.</li>
          <li>Upload it here. erp checks every row before saving anything.</li>
        </ol>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-8 text-center hover:border-accent hover:bg-accent-soft/40 focus-within:outline-2 focus-within:outline-focus">
          {file ? <FileSpreadsheet className="size-6 text-accent-text" aria-hidden /> : <Upload className="size-6 text-accent-text" aria-hidden />}
          <span className="text-base font-medium">{file ? file.name : "Choose the filled file"}</span>
          <span className="text-sm text-text-muted">.xlsx, up to 5 MB</span>
          <input type="file" accept=".xlsx" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {error && <Banner tone="danger">{error}</Banner>}
        {checking && <div className="flex flex-col gap-2" aria-busy aria-label="Checking the file"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24" /></div>}
        {preview && !checking && (
          preview.valid ? (
            <Banner tone="success" title={preview.changes ? `${preview.changes} of ${preview.total} rows change a balance` : "Every balance already matches"}>
              {preview.changes ? "Rows that match today's balance are skipped." : "There's nothing to import."}
            </Banner>
          ) : (
            <Banner tone="danger" title={`${bad.length} of ${preview.total} rows need fixing`}>Nothing is saved until every row is valid.</Banner>
          )
        )}
        {preview && (bad.length > 0 || changes.length > 0) && (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-base">
              <caption className="sr-only">Rows in the file</caption>
              <thead className="sticky top-0 bg-surface-sunken text-left text-sm text-text-muted"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Result</th></tr></thead>
              <tbody>
                {[...bad, ...changes].map((r) => (
                  <tr key={r.rowNumber} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular text-text-muted">{r.rowNumber}</td>
                    <td className="px-3 py-2">{r.name ?? r.employee ?? "—"}</td>
                    <td className="px-3 py-2"><Badge>{r.type || "—"}</Badge></td>
                    <td className="px-3 py-2">{r.errors.length ? (
                      <ul className="flex flex-col gap-0.5 text-sm text-danger-text">{r.errors.map((e) => <li key={e} className="flex gap-1"><XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{e}</li>)}</ul>
                    ) : (
                      <span className="flex items-center gap-1 text-sm"><CheckCircle2 className="size-3.5 text-success-text" aria-hidden />{fmtNum(r.current!)} → <span className="font-medium">{fmtNum(r.balance!)}</span> <span className="text-text-muted">({r.change! > 0 ? "+" : ""}{fmtNum(r.change!)})</span></span>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
