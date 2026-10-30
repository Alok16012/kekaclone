import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { canSeeReports } from "@/server/modules/expenses/access";
import { expenseReport } from "@/server/modules/expenses/service";
import { csvAmount, reportRange, toCsv } from "@/server/modules/expenses/rules";
import { todayIn } from "@/lib/dates";

/** Expense lines as CSV for the chosen period, limited to the people the reader looks after. */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!canSeeReports(actor)) return new Response("You don't have access to expense reports.", { status: 403 });
  const q = new URL(req.url).searchParams;
  const range = reportRange(q.get("from"), q.get("to"), todayIn());
  const r = await withTenant(actor.tenant.id, (tx) => expenseReport(tx, actor, { ...range, includePending: q.get("pending") === "1" }));
  const csv = toCsv([
    ["Date", "Employee", "Department", "Category", "GL code", "Merchant", "Claim", "Claim status", "Amount (INR)"],
    ...r.lines.map((l) => [l.spentOn, l.employee, l.department, l.category, l.gl_code, l.merchant, `#${l.number}`, l.status, csvAmount(l.amountPaise)]),
  ]);
  return new Response("\ufeff" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="expenses-${range.from}-to-${range.to}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
