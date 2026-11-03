/**
 * Monthly overtime and shift-allowance settlement for every tenant: approved overtime → payroll inputs (kind 'overtime')
 * or comp-off credits; shifts worked → shift-allowance inputs. Idempotent, so re-running a month is safe.
 *   pnpm jobs:overtime -- --month 2026-10      (default: last month)
 */
import postgres from "postgres";
import { sql, withTenant } from "@/server/db";
import { addDaysISO, todayIn } from "@/lib/dates";
import { deliverQueued } from "@/server/email";
import { settleOvertime, settleShiftAllowance } from "@/server/modules/attendance/overtime";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const i = process.argv.indexOf("--month");
  const month = i > -1 ? process.argv[i + 1] : addDaysISO(todayIn().slice(0, 8) + "01", -1).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month ?? "")) throw new Error("Use --month YYYY-MM");
  const tenants = await admin<{ id: string; subdomain: string }[]>`select id, subdomain::text from tenants where status in ('trial','active','past_due') order by subdomain`;
  console.log(`Settling overtime and shift allowances for ${month} across ${tenants.length} tenant(s)…`);
  for (const t of tenants) {
    const ot = await withTenant(t.id, (tx) => settleOvertime(tx, t.id, month, null));
    const sa = await withTenant(t.id, (tx) => settleShiftAllowance(tx, t.id, month, null));
    await deliverQueued(t.id);
    const n = (xs: { result: string }[], r: string) => xs.filter((x) => x.result === r).length;
    console.log(`  ${t.subdomain}: overtime ${n(ot.lines, "updated")} updated, ${n(ot.lines, "unchanged")} unchanged, ${n(ot.lines, "skipped")} skipped · allowances ${n(sa.lines, "updated")} updated, ${n(sa.lines, "skipped")} skipped`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await admin.end(); await sql.end(); });
