/**
 * Smoke test for tax declarations, proofs, Form 16 and loans against the seeded demo tenant (run `pnpm db:seed` first).
 * Everything runs in rolled-back transactions, so the demo data stays as seeded (stored file bytes written here are removed at the end).
 *   pnpm smoke:taxloans
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PDFDocument } from "pdf-lib";
import { withTenant, sql, AppError, type Tx } from "@/server/db";
import * as approvals from "@/server/modules/approvals/service";
import * as tax from "@/server/modules/tax/service";
import * as loans from "@/server/modules/loans/service";
import { addMonths, buildSchedule, monthOf } from "@/server/modules/loans/rules";
import { fyLabel, fyStartOf } from "@/server/modules/tax/rules";
import { writeZip } from "@/server/modules/tax/zip";
import { storage } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { DEMO_SUBDOMAIN } from "./demo";
import { DEMO_PANS } from "./seed-taxloans";

const owner = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const rollback = async (tenantId: string, fn: (tx: Tx) => Promise<void>) =>
  withTenant(tenantId, async (tx) => { await fn(tx); await track(tx); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
const blobs: string[] = [];
/** Files written inside this (rolled-back) transaction only: now() is the transaction's start, so seeded files are never touched. */
const track = async (tx: Tx) => { for (const f of await tx<{ storage_key: string }[]>`select storage_key from files where created_at >= now()`) blobs.push(f.storage_key); };

async function main() {
  const [t] = await sql<{ id: string }[]>`select id from tenant_by_subdomain(${DEMO_SUBDOMAIN})`;
  assert.ok(t, "demo tenant exists (run pnpm db:seed)");
  const tenant = { id: t.id, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN };
  const actor = (first: string, permissions: string[] = [], scopes: Scope[] = []) => withTenant(tenant.id, async (tx) => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    assert.ok(e, `${first} exists`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes }] : [] } as Actor;
  });
  const PAY = ["payroll.admin"];
  const asha = await actor("Asha", ["*"]), karan = await actor("Karan", PAY), rohan = await actor("Rohan"), arjun = await actor("Arjun"), meera = await actor("Meera");
  const priya = await actor("Priya", ["employees.read", "employees.write", "leave.admin"]), sneha = await actor("Sneha"), divya = await actor("Divya"), vikram = await actor("Vikram");
  const [sales] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from departments where name = 'Sales'`);
  const salesPay = await actor("Fatima", PAY, [{ type: "department", ids: [sales.id] }]);
  const today = todayIn();
  const fy = fyStartOf(today), lastFy = `${Number(fy.slice(0, 4)) - 1}-04-01`;
  const doc = await PDFDocument.create(); doc.addPage([100, 100]);
  const pdf = new Uint8Array(await doc.save());
  const [group] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`);
  assert.ok(group, "Monthly pay group is seeded");
  const itemId = async (tx: Tx, who: Actor, section: string, item: string) => (await tx<{ id: string }[]>`
    select i.id from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id where d.employee_id = ${who.employeeId} and d.fy_start = ${fy} and i.section = ${section} and i.item = ${item}`)[0]?.id;
  const openWindows = (tx: Tx) => tax.saveTaxSettings(tx, karan, group.id, { editWindow: { mode: "always" }, declarationCutoff: null, proofWindow: null, lateJoinerDays: 30 });

  // ---------- declaration windows (company policy) ----------
  await rollback(tenant.id, async (tx) => {
    const s = { editWindow: { mode: "monthly", fromDay: 1, toDay: 10 }, declarationCutoff: "01-15", proofWindow: { opens: "01-01", closes: "02-28" }, lateJoinerDays: 30 };
    await assert.rejects(tax.saveTaxSettings(tx, arjun, group.id, s), /Only payroll admins for the whole company/);
    await assert.rejects(tax.saveTaxSettings(tx, priya, group.id, s), /Only payroll admins for the whole company/, "HR without payroll.admin");
    await assert.rejects(tax.saveTaxSettings(tx, salesPay, group.id, s), /Only payroll admins for the whole company/, "a scoped payroll admin can't change company windows");
    await assert.rejects(tax.saveTaxSettings(tx, karan, group.id, { ...s, editWindow: { mode: "monthly", fromDay: 12, toDay: 3 } }));
    await tax.saveTaxSettings(tx, karan, group.id, s);
    const [g] = (await tax.listTaxSettings(tx)).filter((x) => x.id === group.id);
    assert.deepEqual(g.settings.editWindow, { mode: "monthly", fromDay: 1, toDay: 10 });
    // the monthly window is closed on the 11th–end of the month (unless the person joined recently)
    const day = Number(today.slice(8, 10));
    if (day > 10) await assert.rejects(tax.saveRegime(tx, rohan, fy, "old"), /from the 1st to the 10th/);
    else assert.deepEqual(await tax.saveRegime(tx, rohan, fy, "old"), { changed: true });
    // a past year is closed for good
    await assert.rejects(tax.saveRegime(tx, rohan, lastFy, "old"), /has ended/);
  });
  ok("declaration windows: only an unscoped payroll admin sets them; monthly window and finished years refuse edits");

  // ---------- declaring ----------
  await rollback(tenant.id, async (tx) => {
    await openWindows(tx);
    await tax.saveRegime(tx, rohan, fy, "old");
    await tax.saveSection(tx, rohan, fy, "80C", [{ item: "ppf", declaredPaise: 2_00_000_00 }, { item: "elss", declaredPaise: 1_00_000_00 }]);
    await assert.rejects(tax.saveSection(tx, rohan, fy, "80C", [{ item: "made_up", declaredPaise: 100 }]), /isn't part of this section/);
    await assert.rejects(tax.saveSection(tx, rohan, fy, "80D", [{ item: "parents", declaredPaise: 100 }, { item: "parents_senior", declaredPaise: 100 }]), /either the regular or the senior/);
    await tax.saveSection(tx, rohan, fy, "80D", [{ item: "self_family", declaredPaise: 40_000_00 }]);
    await tax.saveSection(tx, rohan, fy, "80CCD1B", [{ item: "nps_additional", declaredPaise: 80_000_00 }]);
    await tax.saveHomeLoan(tx, rohan, fy, { interestPaise: 3_50_000_00, lenderName: "Demo Housing Finance", lenderPan: null, lenderAddress: "Mumbai", propertyAddress: "Flat 4, Demo Towers, Pune" });
    // rent above ₹1 lakh a year needs the landlord's PAN
    const rent = { fromMonth: fy, toMonth: addMonths(fy, 11), monthlyRentPaise: 25_000_00, landlordName: "Demo Landlord", landlordAddress: "12 Demo Road", city: "Mumbai", metro: true };
    await assert.rejects(tax.saveRent(tx, rohan, fy, [{ ...rent, landlordPan: null }]), /PAN/);
    await assert.rejects(tax.saveRent(tx, rohan, fy, [{ ...rent, landlordPan: "NOTAPAN" }]), /PAN has 10 characters/);
    await tax.saveRent(tx, rohan, fy, [{ ...rent, landlordPan: "aaapl 2001n" }]);
    await assert.rejects(tax.savePreviousEmployer(tx, rohan, fy, { employerName: "Old Co", tan: null, incomePaise: 5_00_000_00, tdsPaise: 0, pfPaise: 0, ptPaise: 0 }), /joined before/);
    await tax.saveOtherIncome(tx, rohan, fy, { savingsInterestPaise: 12_000_00, depositInterestPaise: 0, otherPaise: 0, otherDescription: "" });

    const me = await tax.myTax(tx, rohan, fy, today);
    assert.equal(me.totals.section80CPaise, 3_00_000_00, "80C is summed here; the tax rates apply the ₹1.5 lakh cap");
    assert.equal(me.totals.section80DPaise, 25_000_00, "80D capped at the (unverified) ₹25,000 for a non-senior family");
    assert.equal(me.totals.section80CCD1BPaise, 50_000_00, "80CCD(1B) capped at ₹50,000");
    assert.equal(me.totals.rentPaise, 12 * 25_000_00);
    assert.ok(me.hraExemptPaise >= 0 && me.hraExemptPaise <= me.projection.hraPaise, "HRA exemption never exceeds the HRA paid");
    assert.ok(me.comparison, me.ratesError ?? "the regimes are compared");
    assert.ok(Number.isInteger(me.comparison!.old.totalTaxPaise) && Number.isInteger(me.comparison!.new.totalTaxPaise), "tax is integer paise");
    assert.equal(me.items.find((i) => i.section === "HRA")!.declaredPaise, 12 * 25_000_00);

    // 80C beyond the cap and 24(b) beyond ₹2 lakh don't lower the old-regime tax
    const before = me.comparison!.old.totalTaxPaise;
    await tax.saveSection(tx, rohan, fy, "80C", [{ item: "ppf", declaredPaise: 1_50_000_00 }, { item: "elss", declaredPaise: 0 }]);
    await tax.saveHomeLoan(tx, rohan, fy, { interestPaise: 2_00_000_00, lenderName: "Demo Housing Finance", lenderPan: null, lenderAddress: "Mumbai", propertyAddress: "Flat 4, Demo Towers, Pune" });
    const after = await tax.myTax(tx, rohan, fy, today);
    assert.equal(after.comparison!.old.totalTaxPaise, before, "80C capped at ₹1.5 lakh and home-loan interest at ₹2 lakh by the rates");
    assert.equal(await itemId(tx, rohan, "80C", "elss"), undefined, "a zero amount removes the item");

    // payroll ignores a draft; it counts once submitted
    const draft = await tax.getTaxInputs(tx, rohan.employeeId, fy, { asOf: today });
    assert.equal(draft.status, "draft");
    assert.equal(draft.deductions.section80CPaise, 0);
    assert.equal(draft.regimeSource, "statutory_profile");
    assert.deepEqual(await tax.submitDeclaration(tx, rohan, fy), { alreadySubmitted: false });
    assert.deepEqual(await tax.submitDeclaration(tx, rohan, fy), { alreadySubmitted: true }, "submitting twice is harmless");
    const sent = await tax.getTaxInputs(tx, rohan.employeeId, fy, { asOf: today });
    assert.equal(sent.status, "submitted");
    assert.equal(sent.regime, "old");
    assert.equal(sent.deductions.section80CPaise, 1_50_000_00);
    assert.equal(sent.deductions.homeLoanInterestPaise, 2_00_000_00);
    assert.equal(sent.hraExemptionPaise, after.hraExemptPaise);
    assert.equal(sent.otherIncomePaise, 12_000_00);
    assert.equal(sent.taxDeductions.section80CPaise, 1_50_000_00, "the employee's PF is left for payroll to add");
  });
  ok("declaring: items per section with 80D / 80CCD(1B) caps, HRA with landlord PAN above ₹1 lakh, home loan; 80C and 24(b) capped in the tax maths; payroll ignores drafts");

  // ---------- proofs ----------
  await rollback(tenant.id, async (tx) => {
    await openWindows(tx);
    await tax.saveSection(tx, rohan, fy, "80C", [{ item: "life_insurance", declaredPaise: 60_000_00 }]);
    await tax.submitDeclaration(tx, rohan, fy);
    const li = await itemId(tx, rohan, "80C", "life_insurance");
    await assert.rejects(tax.uploadProofs(tx, arjun, li, [{ name: "p.pdf", bytes: pdf }]), /not found/, "only the item's owner uploads");
    await assert.rejects(tax.uploadProofs(tx, rohan, li, [{ name: "p.exe", bytes: pdf }]), /PDF, PNG or JPG/);
    await assert.rejects(tax.uploadProofs(tx, rohan, li, [{ name: "fake.pdf", bytes: new TextEncoder().encode("not a pdf at all") }]));
    await tax.uploadProofs(tx, rohan, li, [{ name: "policy.pdf", bytes: pdf }]);

    // the queue: Karan sees it; a Sales-only payroll admin doesn't; Arjun (no payroll access) is refused
    const q = await tax.proofQueue(tx, karan, fy);
    const row = q.find((r) => r.id === li)!;
    assert.ok(row && row.canVerify && row.files.length === 1);
    assert.ok(!(await tax.proofQueue(tx, salesPay, fy)).some((r) => r.id === li), "scoped admins only see their people");
    await assert.rejects(tax.proofQueue(tx, arjun, fy), /Only payroll admins/);
    await assert.rejects(tax.verifyProof(tx, salesPay, li, { decision: "accept" }), /not found/);
    await assert.rejects(tax.verifyProof(tx, arjun, li, { decision: "accept" }), /not found/);

    // decisions need sensible amounts and a comment
    await assert.rejects(tax.verifyProof(tx, karan, li, { decision: "reject" }), /Say why/);
    await assert.rejects(tax.verifyProof(tx, karan, li, { decision: "partial", acceptedPaise: 60_000_00, comment: "x" }), /less than the declared/);
    await assert.rejects(tax.verifyProof(tx, karan, li, { decision: "partial", acceptedPaise: 30_000_00 }), /Say why/);
    assert.deepEqual(await tax.verifyProof(tx, karan, li, { decision: "partial", acceptedPaise: 45_000_00, comment: "Premium receipt shows ₹45,000." }), { status: "partially_accepted", acceptedPaise: 45_000_00 });
    await assert.rejects(tax.verifyProof(tx, karan, li, { decision: "accept" }), /already checked/, "a double click can't decide twice");
    await assert.rejects(tax.saveSection(tx, rohan, fy, "80C", [{ item: "life_insurance", declaredPaise: 70_000_00 }]), /has been verified/);
    await assert.rejects(tax.removeProof(tx, rohan, li, row.files[0].id), /already been verified/);
    const inputs = await tax.getTaxInputs(tx, rohan.employeeId, fy, { asOf: today });
    assert.equal(inputs.bySection.find((b) => b.item === "life_insurance")!.countedPaise, 45_000_00, "payroll counts the accepted amount");
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${rohan.userId} and kind = 'tax.proof' and created_at >= now()`;
    assert.ok(n >= 1, "Rohan is told about the decision");

    // nobody verifies their own proof, even a company-wide admin
    await tax.saveSection(tx, karan, fy, "80C", [{ item: "ppf", declaredPaise: 10_000_00 }]);
    const own = await itemId(tx, karan, "80C", "ppf");
    await tax.uploadProofs(tx, karan, own, [{ name: "mine.pdf", bytes: pdf }]);
    assert.equal((await tax.proofQueue(tx, karan, fy)).find((r) => r.id === own)!.canVerify, false);
    await assert.rejects(tax.verifyProof(tx, karan, own, { decision: "accept" }), /can't verify your own/);
    await tax.verifyProof(tx, asha, own, { decision: "reject", comment: "This is a passbook from last year." });

    // a rejected item counts as nothing; after the proof cut-off, unproven declarations count as nothing too
    assert.equal((await tax.getTaxInputs(tx, karan.employeeId, fy, { asOf: today })).bySection.length, 0, "Karan's declaration is still a draft");
    const late = await tax.getTaxInputs(tx, arjun.employeeId, fy, { asOf: `${Number(fy.slice(0, 4)) + 1}-04-15` });
    assert.equal(late.proofsFinal, true);
    assert.equal(late.bySection.find((b) => b.item === "life_insurance")!.countedPaise, 0, "Arjun's unproven insurance drops out after the cut-off");
    // files: the owner and payroll admins in scope; nobody else
    const file = row.files[0].id;
    assert.ok(await tax.taxFileFor(tx, rohan, file));
    assert.ok(await tax.taxFileFor(tx, karan, file));
    assert.equal(await tax.taxFileFor(tx, arjun, file), null);
    assert.equal(await tax.taxFileFor(tx, salesPay, file), null);
  });
  ok("proofs: owner uploads with type and signature checks; partial/reject need a comment; no double decisions or self-verification; scoped admins only see their people; files stay private");

  // ---------- Form 16 ----------
  await rollback(tenant.id, async (tx) => {
    const zip = writeZip([
      { name: `${DEMO_PANS.Rohan}_PartA.pdf`, bytes: pdf, deflate: true },
      { name: `${DEMO_PANS.Divya.toLowerCase()}-form16.pdf`, bytes: pdf },
      { name: "ZZZZZ9999Z_PartA.pdf", bytes: pdf },
      { name: "readme.txt", bytes: new TextEncoder().encode("hi") },
    ]);
    await assert.rejects(tax.uploadForm16(tx, salesPay, fy, [{ name: "f.zip", bytes: zip }]), /whole company/, "matching by PAN across the company needs an unscoped grant");
    await assert.rejects(tax.uploadForm16(tx, arjun, fy, [{ name: "f.zip", bytes: zip }]), /whole company/);
    await assert.rejects(tax.uploadForm16(tx, karan, fy, [{ name: "broken.zip", bytes: new Uint8Array([1, 2, 3, 4]) }]));
    const r = await tax.uploadForm16(tx, karan, fy, [{ name: "f.zip", bytes: zip }]);
    assert.deepEqual(r.matched.map((m) => m.employee).sort(), ["Divya Pillai", "Rohan Mehta"]);
    assert.equal(r.unmatched.length, 2);
    const list = await tax.form16List(tx, karan, fy);
    const rohanDoc = list.find((x) => x.employeeId === rohan.employeeId)!;
    assert.ok(rohanDoc.file && !rohanDoc.publishedAt);
    assert.equal(await tax.taxFileFor(tx, rohan, rohanDoc.file!.id), null, "not visible to the employee before publishing");
    assert.equal((await tax.myTax(tx, rohan, fy, today)).form16, null);
    await assert.rejects(tax.publishForm16(tx, salesPay, fy, "all"), /whole company/);
    assert.deepEqual(await tax.publishForm16(tx, karan, fy, [rohan.employeeId]), { published: 1 });
    assert.deepEqual(await tax.publishForm16(tx, karan, fy, [rohan.employeeId]), { published: 0 }, "publishing again does nothing");
    assert.ok(await tax.taxFileFor(tx, rohan, rohanDoc.file!.id));
    assert.equal(await tax.taxFileFor(tx, divya, rohanDoc.file!.id), null);
    assert.ok((await tax.myTax(tx, rohan, fy, today)).form16);
    // re-uploading replaces the file and un-publishes it
    const again = await tax.uploadForm16(tx, karan, fy, [{ name: `${DEMO_PANS.Rohan}.pdf`, bytes: pdf }]);
    assert.equal(again.matched[0].replaced, true);
    assert.equal(again.removedKeys.length, 1);
    assert.equal((await tax.form16List(tx, karan, fy)).find((x) => x.employeeId === rohan.employeeId)!.publishedAt, null);
    // the scoped admin's list only has Sales people
    const scoped = await tax.form16List(tx, salesPay, fy);
    assert.ok(scoped.length > 0 && !scoped.some((x) => x.employeeId === rohan.employeeId));
  });
  ok("Form 16: ZIP matched by PAN file name with unmatched files reported; hidden until published; re-upload replaces and un-publishes; unscoped admin only");

  // ---------- PAN ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(tax.savePan(tx, arjun, meera.employeeId, "ABCDE1234F"), /can't change this person's PAN/);
    await assert.rejects(tax.savePan(tx, arjun, arjun.employeeId, "ABC"), /10 characters/);
    await assert.rejects(tax.savePan(tx, arjun, arjun.employeeId, DEMO_PANS.Meera), /Someone else/);
    await tax.savePan(tx, arjun, arjun.employeeId, "abcde 1234 f");
    assert.deepEqual(await tax.panFor(tx, arjun.employeeId), { last4: "234F" });
    const [raw] = await tx<{ enc: Uint8Array }[]>`select number_enc as enc from employee_identities where employee_id = ${arjun.employeeId} and kind = 'pan'`;
    assert.ok(!Buffer.from(raw.enc).toString("latin1").includes("ABCDE1234F"), "the PAN is stored encrypted");
  });
  ok("PAN: own or as payroll admin, validated, unique in the company, encrypted with only the last 4 shown");

  // ---------- loan types ----------
  await rollback(tenant.id, async (tx) => {
    const count = async () => (await tx<{ n: number }[]>`select count(*)::int as n from loan_categories`)[0].n;
    const before = await count();
    await loans.ensureLoanDefaults(tx, tenant.id); await loans.ensureLoanDefaults(tx, tenant.id);
    assert.equal(await count(), before, "defaults are idempotent");
    const input = { name: "Vehicle loan", maxAmountPaise: 3_00_000_00, maxTenureMonths: 24, rateType: "flat", interestRate: "6" };
    await assert.rejects(loans.saveCategory(tx, salesPay, null, input), /whole company/);
    await assert.rejects(loans.saveCategory(tx, arjun, null, input), /whole company/);
    await assert.rejects(loans.saveCategory(tx, karan, null, { ...input, interestRate: "0" }), /Interest-free/);
    const c = await loans.saveCategory(tx, karan, null, input);
    assert.equal((await loans.listCategories(tx)).find((x) => x.id === c.id)!.interestRate, "6.00");
    await assert.rejects(loans.saveCategory(tx, karan, null, input), /already exists/);
  });
  ok("loan types: unscoped payroll admin only; rate checks; duplicate names refused; defaults idempotent");

  // ---------- requesting and approving ----------
  await rollback(tenant.id, async (tx) => {
    const [personal] = (await loans.listCategories(tx)).filter((c) => c.name === "Personal loan");
    await assert.rejects(loans.requestLoan(tx, arjun, { categoryId: personal.id, amountPaise: 6_00_000_00, months: 12, reason: "Too much money" }), /at most|up to|limit/i);
    await assert.rejects(loans.requestLoan(tx, arjun, { categoryId: personal.id, amountPaise: 1_00_000_00, months: 48, reason: "Too long a loan" }), /month/i);
    const r = await loans.requestLoan(tx, arjun, { categoryId: personal.id, amountPaise: 1_00_000_00, months: 12, reason: "Wedding in the family" });
    assert.ok(r.emiPaise > Math.ceil(1_00_000_00 / 12), "a reducing-balance loan's EMI includes interest");
    await assert.rejects(loans.requestLoan(tx, arjun, { categoryId: personal.id, amountPaise: 50_000_00, months: 6, reason: "A second one" }), /already have/);
    const steps = await tx<{ approver: string; level: number }[]>`select s.approver_employee_id as approver, s.level from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} order by s.level`;
    assert.deepEqual(steps.map((s) => s.approver), [rohan.employeeId, karan.employeeId], "manager, then a payroll admin");
    assert.equal((await loans.loanDetail(tx, meera, r.id)), null, "a colleague can't see it");
    assert.ok(await loans.loanDetail(tx, rohan, r.id), "the approver can");
    await assert.rejects(loans.disburseLoan(tx, karan, r.id, { disbursedOn: today, firstEmiMonth: "" }), /waiting for approval/);
    const step = async () => (await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} and s.status = 'pending'`)[0]?.id;
    await assert.rejects(approvals.decide(tx, arjun, await step(), "approved"), /isn't waiting for you/, "never self-approved");
    await approvals.decide(tx, rohan, await step(), "approved");
    await approvals.decide(tx, karan, await step(), "approved");
    assert.equal((await tx<{ status: string }[]>`select status from loans where id = ${r.id}`)[0].status, "approved");

    // a payroll admin's own loan skips them in the chain
    const k = await loans.requestLoan(tx, karan, { categoryId: personal.id, amountPaise: 50_000_00, months: 6, reason: "New laptop for home" });
    const ks = await tx<{ approver: string }[]>`select s.approver_employee_id as approver from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${k.id}`;
    assert.ok(ks.length >= 1 && !ks.some((s) => s.approver === karan.employeeId));

    // withdraw while waiting
    const [adv] = (await loans.listCategories(tx)).filter((c) => c.name === "Salary advance");
    const w = await loans.requestLoan(tx, meera, { categoryId: adv.id, amountPaise: 20_000_00, months: 4, reason: "School fees for my son" });
    await assert.rejects(loans.withdrawLoan(tx, arjun, w.id), /Only a request/);
    await loans.withdrawLoan(tx, meera, w.id);
    assert.equal((await tx<{ status: string }[]>`select status from loans where id = ${w.id}`)[0].status, "cancelled");
    assert.equal((await tx<{ n: number }[]>`select count(*)::int as n from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${w.id} and s.status = 'pending'`)[0].n, 0);
  });
  ok("loan requests: policy limits, one open request per type, manager then payroll admin, never self-approved, withdrawable while waiting");

  // ---------- disbursal, EMIs and payroll inputs ----------
  await rollback(tenant.id, async (tx) => {
    const [vik] = await tx<{ id: string; principal_paise: bigint }[]>`select l.id, l.principal_paise from loans l where l.employee_id = ${vikram.employeeId} and l.status = 'approved'`;
    assert.ok(vik, "Vikram's emergency loan is seeded as approved");
    const first = addMonths(monthOf(today), 1);
    await assert.rejects(loans.disburseLoan(tx, salesPay, vik.id, { disbursedOn: today, firstEmiMonth: first }), /not found/, "a Sales-only admin can't touch an Engineering loan");
    await assert.rejects(loans.disburseLoan(tx, vikram, vik.id, { disbursedOn: today, firstEmiMonth: first }), /not found/);
    await assert.rejects(loans.disburseLoan(tx, karan, vik.id, { disbursedOn: "2999-01-01", firstEmiMonth: "3000-01-01" }), /future/);
    const d = await loans.disburseLoan(tx, karan, vik.id, { disbursedOn: today, firstEmiMonth: first, reference: "UTR SMOKE1" });
    assert.equal(d.alreadyDone, false);
    assert.equal(d.preEmiInterestPaise, 0, "interest-free loans have no pre-EMI interest");
    assert.deepEqual(await loans.disburseLoan(tx, karan, vik.id, { disbursedOn: today, firstEmiMonth: first }), { alreadyDone: true }, "paying out twice is a no-op");
    const sched = await tx<{ p: bigint; i: bigint; n: number }[]>`select sum(principal_paise) as p, sum(interest_paise) as i, count(*)::int as n from loan_installments where loan_id = ${vik.id}`;
    assert.equal(Number(sched[0].p), Number(vik.principal_paise), "EMIs add up to the principal exactly");
    assert.equal(Number(sched[0].i), 0);

    // Sneha's seeded reducing-balance loan: pre-EMI interest is in the first EMI's interest
    const [sn] = await tx<{ id: string; pre: bigint; first: string; principal: bigint; rate: string; months: number }[]>`
      select id, pre_emi_interest_paise as pre, first_emi_month::text as first, principal_paise as principal, interest_rate::text as rate, tenure_months as months from loans where employee_id = ${sneha.employeeId} and status = 'active'`;
    assert.ok(sn && Number(sn.pre) > 0, "Sneha's loan carries pre-EMI interest");
    const plain = buildSchedule({ principalPaise: Number(sn.principal), rateBp: Math.round(Number(sn.rate) * 100), rateType: "reducing", months: sn.months, firstMonth: sn.first });
    const [i1] = await tx<{ interest: bigint }[]>`select interest_paise as interest from loan_installments where loan_id = ${sn.id} order by due_month limit 1`;
    assert.equal(Number(i1.interest), plain[0].interestPaise + Number(sn.pre));

    // payroll inputs: idempotent, one row per EMI
    const run1 = await loans.loanEmisForMonth(tx, group.id, first);
    assert.equal(run1.locked, false);
    const run2 = await loans.loanEmisForMonth(tx, group.id, first);
    assert.deepEqual({ w: run2.written, u: run2.updated, r: run2.removed }, { w: 0, u: 0, r: 0 }, "running again changes nothing");
    assert.equal(run2.totalPaise, run1.totalPaise);
    const inputs = await tx<{ employee_id: string; amount_paise: bigint }[]>`select employee_id, amount_paise from payroll_inputs where kind = 'loan_emi' and pay_group_id = ${group.id} and period_month = ${first}`;
    assert.equal(inputs.length, 2, "Sneha's and Vikram's EMIs");
    assert.equal(inputs.reduce((s, r) => s + Number(r.amount_paise), 0), run2.totalPaise);
    await assert.rejects(loans.loanEmisForMonth(tx, group.id, "2026-05-15"), /first day/);

    // skipping removes the input and moves the EMI to the end
    await assert.rejects(loans.skipEmi(tx, vikram, vik.id, first), /not found/);
    const skip = await loans.skipEmi(tx, karan, vik.id, first, "Medical leave");
    const [{ last }] = await tx<{ last: string }[]>`select max(due_month)::text as last from loan_installments where loan_id = ${vik.id}`;
    assert.equal(skip.movedTo, last);
    await assert.rejects(loans.skipEmi(tx, karan, vik.id, first), /hasn't been taken|Only an EMI/);
    assert.equal((await tx`select 1 from payroll_inputs where kind = 'loan_emi' and employee_id = ${vikram.employeeId} and period_month = ${first}`).length, 0);
    const run3 = await loans.loanEmisForMonth(tx, group.id, first);
    assert.equal(run3.written + run3.updated + run3.removed, 0, "already in sync after the skip");

    // a finalised month is locked: nothing is rewritten and its EMI can't be skipped
    await tx`insert into payroll_runs (tenant_id, pay_group_id, period_month, status) values (${tenant.id}, ${group.id}, ${first}, 'finalized')`;
    assert.equal((await loans.loanEmisForMonth(tx, group.id, first)).locked, true);
    await assert.rejects(loans.skipEmi(tx, karan, sn.id, first), /finalised/);

    // paid: the EMI is marked deducted, and outstanding drops by its principal
    const before = (await loans.outstandingForFnf(tx, sneha.employeeId)).loans[0];
    await tx`update payroll_runs set status = 'paid' where pay_group_id = ${group.id} and period_month = ${first}`;
    assert.ok((await loans.markLoanEmisDeducted(tx, group.id, first)).deducted >= 1);
    assert.deepEqual(await loans.markLoanEmisDeducted(tx, group.id, first), { deducted: 0 }, "marking twice does nothing");
    const afterF = (await loans.outstandingForFnf(tx, sneha.employeeId)).loans[0];
    assert.ok(afterF.outstandingPaise < before.outstandingPaise);
  });
  ok("disbursal: in-scope admin only, idempotent, EMIs sum to principal, pre-EMI interest in the first EMI; loan_emi payroll inputs are idempotent, follow skips and respect finalised months");

  // ---------- prepay, close and F&F ----------
  await rollback(tenant.id, async (tx) => {
    const [sn] = await tx<{ id: string }[]>`select id from loans where employee_id = ${sneha.employeeId} and status = 'active'`;
    const f0 = await loans.outstandingForFnf(tx, sneha.employeeId);
    assert.equal(f0.loans.length, 1);
    const out = f0.loans[0].outstandingPaise;
    assert.equal(f0.totalPaise, out);
    await assert.rejects(loans.prepayLoan(tx, sneha, sn.id, { amountPaise: 1000_00, paidOn: today }), /own loan|not found/);
    await assert.rejects(loans.prepayLoan(tx, karan, sn.id, { amountPaise: out + 1, paidOn: today }), /At most/);
    const part = await loans.prepayLoan(tx, karan, sn.id, { amountPaise: 20_000_00, paidOn: today, reference: "NEFT 1" });
    assert.equal(part.closed, false);
    assert.equal(part.outstandingPaise, out - 20_000_00);
    const [{ p }] = await tx<{ p: bigint }[]>`select sum(principal_paise) as p from loan_installments where loan_id = ${sn.id} and status = 'scheduled'`;
    assert.equal(Number(p), out - 20_000_00, "the open EMIs are rebuilt on the lower balance");
    const f1 = await loans.outstandingForFnf(tx, sneha.employeeId);
    const full = await loans.prepayLoan(tx, asha, sn.id, { amountPaise: f1.loans[0].outstandingPaise, paidOn: today, reference: "F&F" });
    assert.equal(full.closed, true);
    assert.equal((await tx<{ status: string }[]>`select status from loans where id = ${sn.id}`)[0].status, "closed");
    assert.equal((await loans.outstandingForFnf(tx, sneha.employeeId)).totalPaise, 0);
    assert.equal((await tx`select 1 from payroll_inputs where kind = 'loan_emi' and employee_id = ${sneha.employeeId}`).length, 0, "her prepared EMI input is gone");
    await assert.rejects(loans.prepayLoan(tx, karan, sn.id, { amountPaise: 100, paidOn: today }), /being repaid/);

    // an approved-but-unpaid loan shows in F&F with a note and can be cancelled by an admin (not the person)
    const vf = await loans.outstandingForFnf(tx, vikram.employeeId);
    assert.equal(vf.loans[0].status, "approved");
    assert.equal(vf.totalPaise, 0);
    await assert.rejects(loans.cancelApprovedLoan(tx, vikram, vf.loans[0].loanId), /not found/);
    await loans.cancelApprovedLoan(tx, karan, vf.loans[0].loanId);
  });
  ok("prepayment: part payment rebuilds EMIs, full payment closes the loan and clears payroll inputs; outstandingForFnf totals what's owed");

  // ---------- desk visibility ----------
  await rollback(tenant.id, async (tx) => {
    await assert.rejects(loans.loanDesk(tx, arjun), /Only payroll admins/);
    const all = await loans.loanDesk(tx, karan);
    assert.ok(all.some((l) => l.employeeId === sneha.employeeId) && all.some((l) => l.employeeId === vikram.employeeId));
    const scoped = await loans.loanDesk(tx, salesPay);
    assert.ok(scoped.length > 0 && scoped.every((l) => l.employeeId !== vikram.employeeId), "Sales-only admin sees Sales loans only");
    const mine = await loans.myLoans(tx, sneha);
    assert.ok(mine.loans.length >= 1 && mine.loans.every((l) => l.employeeId === sneha.employeeId));
  });
  ok("loan desk is scoped to the admin's people; my loans shows only your own");

  // ---------- tenant isolation ----------
  const otherId = randomUUID();
  await owner`insert into tenants (id, subdomain, name) values (${otherId}, ${"smoke-" + otherId.slice(0, 8)}, 'Smoke Co')`;
  try {
    const [c] = await withTenant(otherId, (tx) => tx<{ n: string }[]>`
      select concat_ws('/', (select count(*) from tax_declarations), (select count(*) from tax_declaration_items), (select count(*) from form16_documents),
        (select count(*) from loan_categories), (select count(*) from loans), (select count(*) from loan_installments), (select count(*) from loan_prepayments),
        (select count(*) from payroll_inputs where kind = 'loan_emi')) as n`);
    assert.equal(c.n, "0/0/0/0/0/0/0/0");
    const [l] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select id from loans where status = 'active' limit 1`);
    const [f] = await withTenant(tenant.id, (tx) => tx<{ id: string }[]>`select part_a_file_id as id from form16_documents limit 1`);
    const outsider = { ...asha, tenant: { ...tenant, id: otherId } } as Actor;
    assert.equal(await withTenant(otherId, (tx) => loans.loanDetail(tx, outsider, l.id)), null);
    assert.equal(await withTenant(otherId, (tx) => tax.taxFileFor(tx, outsider, f.id)), null);
    await assert.rejects(withTenant(otherId, (tx) => loans.prepayLoan(tx, outsider, l.id, { amountPaise: 100, paidOn: today })), /not found/);
    await assert.rejects(withTenant(otherId, (tx) => tx`insert into loan_categories (tenant_id, name, rate_type, interest_rate) values (${tenant.id}, 'sneaky', 'zero', 0)`), /row-level security/);
    assert.equal((await withTenant(otherId, (tx) => tx`update loans set status = 'closed' where id = ${l.id}`)).count, 0);
    ok("another tenant sees none of Acme's declarations, Form 16s, loans, EMIs or payroll inputs and can't change them");
  } finally {
    await owner`delete from tenants where id = ${otherId}`;
  }

  console.log(`  (FY ${fyLabel(fy)}; every tax limit and rate here is unverified and needs a CA's check)`);
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.log(`\n${passed} checks passed`);
}

main().then(async () => { await owner.end(); await sql.end(); }).catch(async (e) => {
  for (const k of blobs) await storage().remove(k).catch(() => {});
  console.error("\nFAILED:", e instanceof AppError ? `${e.code}: ${e.message}` : e); await owner.end(); await sql.end(); process.exit(1);
});
