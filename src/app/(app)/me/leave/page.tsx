import type { Metadata } from "next";
import { load, leaveMarks } from "@/server/page-data";
import * as leave from "@/server/modules/leave/service";
import { orgOptions } from "@/server/modules/employees/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { ApplyLeave } from "@/features/apply-leave";
import { LeaveRequests, type RequestRow } from "@/features/leave-requests";

export const metadata: Metadata = { title: "Leave" };

const part = (r: { from_date: string; to_date: string; from_half: string; to_half: string }) =>
  r.from_date === r.to_date ? (r.from_half === "second" ? "Second half" : r.to_half === "first" ? "First half" : null)
  : [r.from_half === "second" ? "from 2nd half" : null, r.to_half === "first" ? "till 1st half" : null].filter(Boolean).join(", ") || null;

export default async function LeavePage(props: PageProps<"/me/leave">) {
  const apply = (await props.searchParams).apply === "1";
  const d = await load(async (tx, actor) => {
    const [bal, reqs, marks, opts] = await Promise.all([leave.balances(tx, actor.employeeId), leave.myRequests(tx, actor.employeeId), leaveMarks(tx, actor.employeeId), orgOptions(tx)]);
    return { bal, reqs, marks, people: opts.people.filter((p) => p.id !== actor.employeeId) };
  });
  const today = todayIn();
  const rows: RequestRow[] = d.reqs.map((r) => ({
    id: r.id, type: r.type, color: r.color, range: leave.fmtRange(r.from_date, r.to_date), days: Number(r.days), part: part(r), status: r.status, note: r.note,
    cancellable: r.status === "pending" || (r.status === "approved" && r.from_date >= today),
  }));
  const types = d.bal.map((b) => ({ id: b.id, name: b.name, available: Number.isFinite(b.available) ? b.available : null, allowHalfDay: !!b.rules.allowHalfDay }));
  return (
    <>
      <PageHeader title="Leave" description="Your balances, requests and approvals." actions={<ApplyLeave types={types} marks={d.marks} people={d.people} defaultOpen={apply} />} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {d.bal.map((b) => (
          <Card key={b.id} className="p-4">
            <div className="flex items-center gap-2"><span aria-hidden className="size-2.5 rounded-pill" style={{ background: b.color }} /><span className="text-sm font-medium">{b.name}</span></div>
            <p className="mt-2 text-2xl font-semibold tabular">{b.quota == null ? "—" : b.available}<span className="ml-1 text-sm font-normal text-text-muted">{b.quota == null ? "no limit" : "available"}</span></p>
            <p className="mt-1 text-sm text-text-muted tabular">{b.quota == null ? `${b.used} used this year` : `${b.credited} credited · ${b.used} used${b.pending ? ` · ${b.pending} pending` : ""}`}</p>
          </Card>
        ))}
      </div>
      <LeaveRequests rows={rows} />
    </>
  );
}
