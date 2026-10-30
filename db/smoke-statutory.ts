/**
 * Smoke test for statutory rates + CA verification against the seeded demo tenant (run `pnpm db:seed` first).
 * Runs in rolled-back transactions; the one committed verification (for the tenant isolation check) is deleted at the end.
 *   pnpm smoke:statutory
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as st from "@/server/modules/statutory/service";
import { RATE_ROWS } from "@/server/modules/statutory/rates-data";
import { annualTax, esi, pf, professionalTax, projectTds, remainingMonthsInFy } from "@/server/modules/statutory/rules";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const adminRollback = async (fn: (tx: postgres.TransactionSql) => Promise<void>) =>
  admin.begin(async (tx) => { await fn(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const r = (rupees: number) => Math.round(rupees * 100);

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const [eng] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Engineering'`);
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", ["payroll.admin"]), rohan = await actor("Rohan");
  const scoped = await actor("Fatima", ["payroll.admin"], [{ type: "department", ids: [eng.id] }]);
  const priya = await actor("Priya", ["settings.org", "employees.read"]);
  const today = todayIn();

  // ---------- data in the table ----------
  {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from statutory_rates`;
    assert.equal(rows[0].n, RATE_ROWS.length, "every rate in rates-data.ts is in the table");
    const unverified = await sql<{ n: number }[]>`select count(*)::int as n from statutory_rates where source_note not like '%Unverified%'`;
    assert.equal(unverified[0].n, 0, "every row is marked unverified");
    await adminRollback(async (tx) => {
      const again = await st.syncStatutoryRates(tx as unknown as postgres.Sql);
      assert.deepEqual([again.inserted, again.updated], [0, 0], "re-running the sync changes nothing");
      const changed = RATE_ROWS.map((x) => (x.kind === "pf" ? { ...x, config: { ...x.config, wageCeilingPaise: r(16_000) } } : x));
      const s2 = await st.syncStatutoryRates(tx as unknown as postgres.Sql, changed as typeof RATE_ROWS);
      assert.deepEqual([s2.inserted, s2.updated], [0, 1], "a changed rate updates its row in place");
      await assert.rejects(tx.savepoint((sp) => sp`insert into statutory_rates (kind, effective_from, config, source_note) values ('pf', '2014-09-01', '{}', 'dup')`), /duplicate key/, "one version per kind/start date even without a state");
    });
  }
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(tx.savepoint((sp) => sp`insert into statutory_rates (kind, effective_from, config, source_note) values ('pf', '2030-01-01', '{}', 'x')`), /permission denied/);
    await assert.rejects(tx.savepoint((sp) => sp`update statutory_rates set source_note = 'verified' where kind = 'pf'`), /permission denied/);
  });
  ok("rates: every row loaded and marked unverified; sync is idempotent and updates in place; one version per start date; the app can't write them");

  // ---------- loadRates ----------
  await rollback(tenant.id, async (tx) => {
    const ka = await st.loadRates(tx, "2025-06-15", "ka");
    assert.equal(ka.fy, "2025-26");
    assert.equal(ka.pt?.config.stateName, "Karnataka"); assert.equal(ka.lwf?.config.stateName, "Karnataka");
    assert.equal(ka.incomeTax.new.config.fy, "2025-26"); assert.equal(ka.incomeTax.old.config.regime, "old");
    assert.equal(pf({ config: ka.pf.config, pfWagePaise: r(30_000) }).employeePaise, r(1_800));
    assert.equal(esi({ config: ka.esi.config, grossPaise: r(21_000) }).employeePaise, r(158));
    assert.equal(professionalTax({ config: ka.pt!.config, month: 2, grossPaise: r(30_000) }).amountPaise, r(300));
    const next = await st.loadRates(tx, "2026-06-01", "MH");
    assert.equal(next.incomeTax.new.config.fy, "2026-27");
    assert.match(next.incomeTax.new.sourceNote, /Assumed same as previous year/);
    assert.equal(annualTax({ config: next.incomeTax.new.config, grossIncomePaise: r(1_275_000) }).totalTaxPaise, 0);
    const dl = await st.loadRates(tx, "2025-06-15", "DL");
    assert.equal(dl.pt, null, "a state without PT in erp → no PT, not an error");
    assert.equal((await st.loadRates(tx, "2025-06-15")).lwf, null);
    await assert.rejects(st.loadRates(tx, "2013-01-01", "KA"), (e: unknown) => e instanceof AppError && e.code === "not_found" && /No PF rates/.test(e.message));
    await assert.rejects(st.loadRates(tx, "2027-06-01", "KA"), /No income tax \(old regime\)/, "no silent zero tax for a year without slabs");
    await assert.rejects(st.loadRates(tx, "15/06/2025", "KA"), /valid date/);
    const tax = await st.loadTaxRates(tx, "2025-26", "new");
    const tds = projectTds({ fy: "2025-26", regime: "new", config: tax.config, ytdTaxablePaise: 0, projectedTaxablePaise: r(1_800_000), tdsDeductedPaise: 0, remainingMonths: remainingMonthsInFy("2025-04-10") });
    assert.equal(tds.monthlyTdsPaise, r(12_567));
    await assert.rejects(st.loadTaxRates(tx, "2030-31", "new"), /FY 2030-31/);
  });
  ok("loadRates: national + state rates by date, FY 2026-27 assumed same, missing state → null, missing national/tax → error; engine works on loaded rates");

  // ---------- permissions ----------
  await rollback(tenant.id, async (tx) => {
    const { fingerprint } = await st.verificationStatus(tx);
    const input = { verifiedByName: "R. Iyer & Co.", verifiedOn: today, note: "Checked all tables, membership 123456", confirm: true as const, fingerprint };
    assert.equal(st.canViewRates(rohan), false); assert.equal(st.canViewRates(priya), true); assert.equal(st.canViewRates(scoped), true);
    assert.equal(st.canRecordVerification(scoped), false, "a department-scoped payroll admin can't make a company-wide statement");
    assert.equal(st.canRecordVerification(karan), true); assert.equal(st.canRecordVerification(asha), true);
    for (const who of [rohan, scoped, priya]) await assert.rejects(st.recordVerification(tx, who, input, today), /company-wide access/);
    assert.equal((await st.verificationStatus(tx)).verified, false, "refused attempts record nothing");
  });
  ok("permissions: only unscoped payroll.admin (or *) records a CA check; scoped admins, settings.org and employees can't; viewing needs payroll or settings access");

  // ---------- validation ----------
  await rollback(tenant.id, async (tx) => {
    const { fingerprint } = await st.verificationStatus(tx);
    const base = { verifiedByName: "R. Iyer & Co.", verifiedOn: today, note: "Checked all tables", confirm: true as const, fingerprint };
    const bad = async (patch: object, re: RegExp, field?: string) => {
      const e = await st.recordVerification(tx, karan, { ...base, ...patch } as typeof base, today).then(() => null, (x) => x);
      assert.ok(e instanceof AppError, `refused: ${JSON.stringify(patch)}`); assert.match(e.message, re); if (field) assert.equal(e.field, field);
    };
    await bad({ verifiedByName: " " }, /CA or firm/, "verifiedByName");
    await bad({ note: "ok" }, /short note/, "note");
    await bad({ confirm: false }, /Confirm/, "confirm");
    await bad({ verifiedOn: addDaysISO(today, 1) }, /future/, "verifiedOn");
    await bad({ verifiedOn: addDaysISO(today, -400) }, /more than a year/, "verifiedOn");
    await bad({ verifiedOn: "yesterday" }, /date/, "verifiedOn");
    await bad({ fingerprint: "0".repeat(64) }, /changed while you were looking/);
  });
  ok("validation: name, note, explicit confirmation, no future or year-old sign-off, and the rates must be the ones on screen");

  // ---------- record, idempotent, banner off, audit ----------
  await rollback(tenant.id, async (tx) => {
    const before = await st.verificationStatus(tx);
    assert.deepEqual([before.verified, before.stale, before.latest], [false, false, null], "demo starts unverified (banner on)");
    assert.equal(await st.ratesNeedVerification(tx), true);
    const input = { verifiedByName: "R. Iyer & Co.", verifiedOn: addDaysISO(today, -3), note: "  Checked all tables  ", confirm: true as const, fingerprint: before.fingerprint };
    const a = await st.recordVerification(tx, karan, input, today);
    assert.equal(a.alreadyRecorded, false);
    const b = await st.recordVerification(tx, asha, input, today);
    assert.deepEqual(b, { id: a.id, alreadyRecorded: true }, "recording the same rates twice is a no-op");
    const after = await st.verificationStatus(tx);
    assert.equal(after.verified, true); assert.equal(await st.ratesNeedVerification(tx), false);
    assert.equal(after.latest?.note, "Checked all tables"); assert.equal(after.latest?.recorded_by_name, "Karan Singh");
    assert.equal(after.latest?.rates_count, RATE_ROWS.length);
    assert.equal((await st.listVerifications(tx)).length, 1);
    const [log] = await tx<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'statutory.verified' and entity_id = ${a.id} and actor_user_id = ${karan.userId}`;
    assert.equal(log.n, 1, "audited once");
    await assert.rejects(tx.savepoint((sp) => sp`update statutory_verifications set note = 'edited' where id = ${a.id}`), /permission denied/);
    await assert.rejects(tx.savepoint((sp) => sp`delete from statutory_verifications where id = ${a.id}`), /permission denied/);
  });
  ok("record: banner on → recorded → banner off; repeating is idempotent; audited; history is append-only for the app");

  // ---------- a rate change makes the verification stale ----------
  await adminRollback(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenant.id}, true)`;
    const db = tx as unknown as Tx;
    const fp = await st.ratesFingerprint(db);
    await tx`insert into statutory_verifications (tenant_id, verified_by_name, verified_on, note, rates_fingerprint, rates_count) values (${tenant.id}, 'CA', ${today}, 'checked all', ${fp.fingerprint}, ${fp.count})`;
    assert.equal((await st.verificationStatus(db)).verified, true);
    await tx`update statutory_rates set config = jsonb_set(config, '{wageCeilingPaise}', '1600000') where kind = 'pf'`;
    const s = await st.verificationStatus(db);
    assert.deepEqual([s.verified, s.stale, s.latest?.verified_by_name], [false, true, "CA"], "changed rates bring the banner back");
    assert.notEqual(s.fingerprint, fp.fingerprint);
  });
  ok("stale: changing any rate after a CA check brings the warning back (marked as changed since the check)");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  let committed: string | null = null;
  await admin`insert into tenants (id, subdomain, name) values (${otherId}, ${"statutory-smoke-" + otherId.slice(0, 8)}, 'Other Co')`;
  try {
    committed = await withTenant(tenant.id, async (tx) => {
      const { fingerprint } = await st.verificationStatus(tx);
      return (await st.recordVerification(tx, karan, { verifiedByName: "Acme's CA", verifiedOn: today, note: "Acme only", confirm: true, fingerprint }, today)).id;
    });
    await withTenant(otherId, async (tx) => {
      const s = await st.verificationStatus(tx);
      assert.deepEqual([s.verified, s.latest], [false, null], "Acme's CA check doesn't remove another company's banner");
      assert.equal((await st.listVerifications(tx)).length, 0);
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from statutory_verifications`;
      assert.equal(n, 0);
      await assert.rejects(tx.savepoint((sp) => sp`insert into statutory_verifications (tenant_id, verified_by_name, verified_on, note, rates_fingerprint, rates_count) values (${tenant.id}, 'x', ${today}, 'sneaky', ${s.fingerprint}, 1)`), /row-level security/);
      assert.equal((await st.loadRates(tx, today, "KA")).pf.config.employeeBp, 1200, "global rates are readable by every company");
    });
    assert.equal(await withTenant(tenant.id, (tx) => st.ratesNeedVerification(tx)), false);
  } finally {
    if (committed) await admin`delete from statutory_verifications where id = ${committed}`;
    await admin`delete from audit_logs where action = 'statutory.verified' and entity_id = ${committed}`;
    await admin`delete from tenants where id = ${otherId}`;
  }
  ok("isolation: one company's CA check is invisible to another, can't be forged across tenants; rates are shared read-only");

  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await admin.end(); await sql.end(); }).catch(async (e) => {
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e);
  await admin.end(); await sql.end(); process.exit(1);
});
