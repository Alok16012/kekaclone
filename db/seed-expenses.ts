/**
 * Demo data for expenses on the seeded tenant (called from db/seed.ts): the Standard policy and categories, Karan in the
 * Finance role, and a few claims at every stage: Arjun's waiting for Rohan, Meera's waiting for finance, Vikram's approved and
 * waiting for payout, Sneha's advance (paid) with a claim settled against it, and Imran's unclaimed expenses with a policy flag.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { withTenant, type Tx } from "@/server/db";
import { decide } from "@/server/modules/approvals/service";
import { ensureExpenseDefaults } from "@/server/modules/expenses/admin";
import * as exp from "@/server/modules/expenses/service";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

async function receiptPdf(merchant: string, amount: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(merchant, { x: 24, y: 150, size: 14, font });
  page.drawText(`Amount paid: Rs ${amount}`, { x: 24, y: 120, size: 11, font });
  page.drawText("Demo receipt", { x: 24, y: 96, size: 9, font });
  return new Uint8Array(await doc.save());
}

export async function seedExpenses(tenantId: string) {
  const today = todayIn();
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  await withTenant(tenantId, async (tx) => {
    await ensureExpenseDefaults(tx, tenantId);
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenantId}, id, (select id from employees where first_name = 'Karan') from roles where key = 'finance'
             on conflict do nothing`;
  });
  const FIN = ["expenses.approve", "expenses.payout"];
  const [arjun, meera, vikram, sneha, imran, rohan, asha, karan] = await Promise.all(
    ["Arjun", "Meera", "Vikram", "Sneha", "Imran", "Rohan", "Asha", "Karan"].map((n) => actor(n, n === "Karan" ? FIN : n === "Asha" ? ["*"] : [])));
  const cat = async (tx: Tx, name: string) => (await tx<{ id: string }[]>`select id from expense_categories where name = ${name}`)[0].id;
  const base = { amountPaise: null, kmHundredths: null, halfDays: null, merchant: null, description: null };
  const approveNext = async (who: Actor, entityId: string) => withTenant(tenantId, async (tx) => {
    const [s] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_id = ${entityId} and s.status = 'pending' and s.approver_employee_id = ${who.employeeId}`;
    await decide(tx, who, s.id, "approved", "Looks good");
  });

  // Arjun: client visit, waiting for Rohan
  const arjunClaim = await withTenant(tenantId, async (tx) => {
    const a = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Local conveyance"), spentOn: addDaysISO(today, -6), kmHundredths: 4250, merchant: "Own car", description: "Office to client site in Hinjewadi and back" });
    const b = await exp.addExpense(tx, arjun, { ...base, categoryId: await cat(tx, "Meals"), spentOn: addDaysISO(today, -6), amountPaise: 86000, merchant: "Vaishali Restaurant", description: "Lunch with the client team" },
      [{ name: "lunch-receipt.pdf", bytes: await receiptPdf("Vaishali Restaurant", "860.00") }]);
    const c = await exp.createClaim(tx, arjun, { title: "Client visit, Pune", expenseIds: [a.id, b.id] });
    await exp.submitClaim(tx, arjun, c.id);
    return c.id;
  });
  void arjunClaim;

  // Meera: conference travel, Rohan approved, waiting for finance (Karan)
  const meeraClaim = await withTenant(tenantId, async (tx) => {
    const a = await exp.addExpense(tx, meera, { ...base, categoryId: await cat(tx, "Travel"), spentOn: addDaysISO(today, -12), amountPaise: 642500, merchant: "IndiGo", description: "Return flight BLR–DEL for DevConf" },
      [{ name: "flight-invoice.pdf", bytes: await receiptPdf("IndiGo", "6,425.00") }]);
    const b = await exp.addExpense(tx, meera, { ...base, categoryId: await cat(tx, "Per diem"), spentOn: addDaysISO(today, -11), halfDays: 3, description: "Conference days in Delhi" });
    const c = await exp.createClaim(tx, meera, { title: "DevConf Delhi", expenseIds: [a.id, b.id] });
    await exp.submitClaim(tx, meera, c.id);
    return c.id;
  });
  await approveNext(rohan, meeraClaim);

  // Vikram: approved by Rohan and Karan, waiting for payout
  const vikramClaim = await withTenant(tenantId, async (tx) => {
    const a = await exp.addExpense(tx, vikram, { ...base, categoryId: await cat(tx, "Internet and phone"), spentOn: addDaysISO(today, -20), amountPaise: 99900, merchant: "Airtel", description: "Home broadband" },
      [{ name: "airtel-bill.pdf", bytes: await receiptPdf("Airtel", "999.00") }]);
    const c = await exp.createClaim(tx, vikram, { title: "Broadband, last month", expenseIds: [a.id] });
    await exp.submitClaim(tx, vikram, c.id);
    return c.id;
  });
  await approveNext(rohan, vikramClaim);
  await approveNext(karan, vikramClaim);

  // Sneha: ₹5,000 advance for a sales trip, paid; her ₹7,800 claim uses all of it and ₹2,800 is left to pay
  const adv = await withTenant(tenantId, (tx) => exp.requestAdvance(tx, sneha, { amountPaise: 500000, purpose: "Sales trip to Mumbai customers" }));
  await approveNext(asha, adv.id);
  await approveNext(karan, adv.id);
  await withTenant(tenantId, (tx) => exp.markAdvancePaid(tx, karan, adv.id, "UPI 6283 1190"));
  const snehaClaim = await withTenant(tenantId, async (tx) => {
    const a = await exp.addExpense(tx, sneha, { ...base, categoryId: await cat(tx, "Travel"), spentOn: addDaysISO(today, -4), amountPaise: 780000, merchant: "Hotel Sea Breeze", description: "Two nights near the customer office" },
      [{ name: "hotel-invoice.pdf", bytes: await receiptPdf("Hotel Sea Breeze", "7,800.00") }]);
    const c = await exp.createClaim(tx, sneha, { title: "Mumbai sales trip", expenseIds: [a.id], advanceId: adv.id });
    await exp.submitClaim(tx, sneha, c.id);
    return c.id;
  });
  await approveNext(asha, snehaClaim);
  await approveNext(karan, snehaClaim);

  // Imran: unclaimed expenses, one missing its receipt
  await withTenant(tenantId, async (tx) => {
    await exp.addExpense(tx, imran, { ...base, categoryId: await cat(tx, "Meals"), spentOn: addDaysISO(today, -2), amountPaise: 120000, merchant: "Barbeque Nation", description: "Dinner with a prospect" });
    await exp.addExpense(tx, imran, { ...base, categoryId: await cat(tx, "Local conveyance"), spentOn: addDaysISO(today, -1), kmHundredths: 1800, merchant: "Own bike" });
  });
}
