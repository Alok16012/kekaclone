/**
 * Demo tax declarations and loans for the seeded tenant (called from db/seed.ts). Made-up test PANs (not real people's),
 * the Monthly pay group's declaration windows (proofs open from October so the demo can upload), and:
 *   - Arjun: old regime, 80C + 80D + rent, submitted, a PPF proof waiting for Karan to check
 *   - Meera: submitted, her ELSS proof partly accepted by Karan
 *   - Sneha: a draft not yet sent to payroll
 *   - Arjun's Form 16 Part A for last year, uploaded as a PAN-named ZIP and shared
 *   - loans: Sneha's personal loan paid out and repaying (with pre-EMI interest), Vikram's emergency loan approved and
 *     waiting to be paid out, Imran's salary advance waiting for his manager; next month's EMIs prepared for payroll.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { withTenant, type Tx } from "@/server/db";
import { decide } from "@/server/modules/approvals/service";
import * as tax from "@/server/modules/tax/service";
import * as loans from "@/server/modules/loans/service";
import { fyLabel, fyStartOf } from "@/server/modules/tax/rules";
import { addMonths, monthOf } from "@/server/modules/loans/rules";
import { writeZip } from "@/server/modules/tax/zip";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

/** Test PANs in the right shape (5 letters, 4 digits, a letter); the 4th letter P marks an individual. */
export const DEMO_PANS: Record<string, string> = {
  Asha: "AAAPV1001A", Rohan: "AAAPM1002B", Priya: "AAAPN1003C", Karan: "AAAPS1004D", Arjun: "AAAPR1005E", Meera: "AAAPI1006F",
  Vikram: "AAAPJ1007G", Sneha: "AAAPK1008H", Imran: "AAAPK1009J", Divya: "AAAPP1010K", Aditya: "AAAPB1011L", Fatima: "AAAPS1012M",
};

async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 24, y: 260 - i * 20, size: i ? 10 : 14, font }));
  return new Uint8Array(await doc.save());
}

export async function seedTaxLoans(tenantId: string) {
  const today = todayIn();
  const fy = fyStartOf(today);
  const lastFy = `${Number(fy.slice(0, 4)) - 1}-04-01`;
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  const karan = await actor("Karan", ["payroll.admin"]);
  const [arjun, meera, sneha, imran, vikram] = await Promise.all(["Arjun", "Meera", "Sneha", "Imran", "Vikram"].map((n) => actor(n)));

  await withTenant(tenantId, async (tx) => {
    await loans.ensureLoanDefaults(tx, tenantId);
    const [g] = await tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`;
    if (g) await tax.saveTaxSettings(tx, karan, g.id, { editWindow: { mode: "always" }, declarationCutoff: "01-15", proofWindow: { opens: "10-01", closes: "02-28" }, lateJoinerDays: 30 });
    for (const [first, pan] of Object.entries(DEMO_PANS)) {
      const p = await actor(first);
      await tax.savePan(tx, p, p.employeeId, pan);
    }
  });

  // Declarations — the seeding time stands in for "today"; proofs need the window above to be open
  const proofsOpen = today >= `${fy.slice(0, 4)}-10-01` && today <= `${Number(fy.slice(0, 4)) + 1}-02-28`;
  await withTenant(tenantId, async (tx) => {
    await tax.saveRegime(tx, arjun, fy, "old");
    await tax.saveSection(tx, arjun, fy, "80C", [{ item: "ppf", declaredPaise: 1_00_000_00 }, { item: "life_insurance", declaredPaise: 30_000_00 }]);
    await tax.saveSection(tx, arjun, fy, "80D", [{ item: "self_family", declaredPaise: 18_000_00 }, { item: "parents_senior", declaredPaise: 32_000_00 }]);
    await tax.saveRent(tx, arjun, fy, [{ fromMonth: fy, toMonth: addMonths(fy, 11), monthlyRentPaise: 22_000_00, landlordName: "Lakshmi Narayan", landlordPan: "AAAPL2001N", landlordAddress: "14, 3rd Cross, Indiranagar", city: "Bengaluru", metro: false }]);
    await tax.submitDeclaration(tx, arjun, fy);

    await tax.saveSection(tx, meera, fy, "80C", [{ item: "elss", declaredPaise: 50_000_00 }, { item: "tuition_fees", declaredPaise: 40_000_00 }]);
    await tax.saveOtherIncome(tx, meera, fy, { savingsInterestPaise: 8_500_00, depositInterestPaise: 12_000_00, otherPaise: 0, otherDescription: "" });
    await tax.submitDeclaration(tx, meera, fy);

    await tax.saveSection(tx, sneha, fy, "80CCD1B", [{ item: "nps_additional", declaredPaise: 50_000_00 }]);
  });
  if (proofsOpen) {
    await withTenant(tenantId, async (tx) => {
      const item = async (who: Actor, section: string, it: string) => (await tx<{ id: string }[]>`
        select i.id from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id where d.employee_id = ${who.employeeId} and d.fy_start = ${fy} and i.section = ${section} and i.item = ${it}`)[0].id;
      await tax.uploadProofs(tx, arjun, await item(arjun, "80C", "ppf"), [{ name: "ppf-passbook.pdf", bytes: await pdf(["PPF account statement", "Deposits this year: Rs 1,00,000", "Demo document"]) }]);
      const elss = await item(meera, "80C", "elss");
      await tax.uploadProofs(tx, meera, elss, [{ name: "elss-statement.pdf", bytes: await pdf(["ELSS investment statement", "Invested: Rs 40,000", "Demo document"]) }]);
      await tax.verifyProof(tx, karan, elss, { decision: "partial", acceptedPaise: 40_000_00, comment: "The statement shows ₹40,000 invested so far this year." });
    });
  }

  // Last year's Form 16 Part A for Arjun, from a PAN-named ZIP
  await withTenant(tenantId, async (tx) => {
    const zip = writeZip([{ name: `${DEMO_PANS.Arjun}_${fyLabel(lastFy)}_PartA.pdf`, bytes: await pdf([`Form 16 Part A (demo), FY ${fyLabel(lastFy)}`, "Not a real certificate", `PAN ${DEMO_PANS.Arjun}`]), deflate: true }]);
    await tax.uploadForm16(tx, karan, lastFy, [{ name: "form16-part-a.zip", bytes: zip }]);
    await tax.publishForm16(tx, karan, lastFy, "all");
  });

  // Loans
  const approveAll = async (tx: Tx, loanId: string) => {
    for (;;) {
      const [s] = await tx<{ id: string; approver: string }[]>`select s.id, s.approver_employee_id as approver from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'loan' and r.entity_id = ${loanId} and s.status = 'pending'`;
      if (!s) return;
      const [e] = await tx<{ first_name: string }[]>`select first_name from employees where id = ${s.approver}`;
      await decide(tx, await actor(e.first_name), s.id, "approved", "Approved for the demo");
    }
  };
  const cat = async (tx: Tx, name: string) => (await tx<{ id: string }[]>`select id from loan_categories where name = ${name}`)[0].id;
  await withTenant(tenantId, async (tx) => {
    const personal = await loans.requestLoan(tx, sneha, { categoryId: await cat(tx, "Personal loan"), amountPaise: 1_20_000_00, months: 12, reason: "Home repairs after the monsoon" });
    await approveAll(tx, personal.id);
    const paidOn = addDaysISO(`${today.slice(0, 7)}-01`, -21);   // ~3 weeks before this month: a little pre-EMI interest
    await loans.disburseLoan(tx, karan, personal.id, { disbursedOn: paidOn, firstEmiMonth: addMonths(monthOf(today), 1), reference: "UTR DEMO0001" });

    const emergency = await loans.requestLoan(tx, vikram, { categoryId: await cat(tx, "Emergency loan"), amountPaise: 60_000_00, months: 6, reason: "Hospital bills for my father" });
    await approveAll(tx, emergency.id);

    await loans.requestLoan(tx, imran, { categoryId: await cat(tx, "Salary advance"), amountPaise: 30_000_00, months: 6, reason: "Deposit for a new flat" });

    const [g] = await tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`;
    if (g) await loans.loanEmisForMonth(tx, g.id, addMonths(monthOf(today), 1));
  });
}
