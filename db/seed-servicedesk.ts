/**
 * Demo data for the helpdesk and assets on the seeded tenant (called from db/seed.ts):
 * three ticket categories with agents and SLAs, tickets in every state (one past its targets, one reopened),
 * an inventory of laptops, monitors, headsets and ID cards, hand-overs (some confirmed, one not), a damaged return
 * with a recovery, Divya (serving notice) still holding her laptop, one request waiting for a manager and one to hand over.
 */
import { withTenant } from "@/server/db";
import * as hd from "@/server/modules/helpdesk/service";
import * as assets from "@/server/modules/assets/service";
import { decide } from "@/server/modules/approvals/service";
import type { Actor } from "@/server/auth/session";

const HOUR = 3600_000;

export async function seedServiceDesk(tenantId: string) {
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  const HR = ["employees.read", "employees.write", "helpdesk.admin", "assets.admin", "exits.manage"];
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", HR);
  const [rohan, arjun, meera, vikram, sneha, imran, divya, karan, fatima] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Sneha", "Imran", "Divya", "Karan", "Fatima"].map((n) => actor(n)));
  const now = Date.now();

  // ---------- helpdesk ----------
  await withTenant(tenantId, async (tx) => {
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["helpdesk.admin", "assets.admin"]}::text[]) p) where key = 'hr_admin'`;
    await hd.ensureHelpdeskDefaults(tx, tenantId);
    const cat = async (name: string) => (await tx<{ id: string }[]>`select id from ticket_categories where name = ${name}`)[0].id;
    const it = await cat("IT support"), hr = await cat("HR questions"), pay = await cat("Payroll and reimbursements");
    await hd.saveCategory(tx, asha, it, { name: "IT support", priority: "high", firstResponseMins: 240, resolutionMins: 2 * 1440, assigneeIds: [vikram.employeeId], escalateToId: rohan.employeeId });
    await hd.saveCategory(tx, asha, hr, { name: "HR questions", priority: "medium", firstResponseMins: 480, resolutionMins: 3 * 1440, assigneeIds: [priya.employeeId], escalateToId: asha.employeeId });
    await hd.saveCategory(tx, asha, pay, { name: "Payroll and reimbursements", priority: "medium", firstResponseMins: 480, resolutionMins: 5 * 1440, assigneeIds: [karan.employeeId, fatima.employeeId], escalateToId: asha.employeeId });

    // Arjun: VPN trouble, Vikram answered and is working on it
    const vpn = await hd.raiseTicket(tx, arjun, { categoryId: it, title: "VPN drops every few minutes", description: "Since yesterday the VPN disconnects every 5–10 minutes when I'm working from home. Restarting the client doesn't help.", files: [] }, new Date(now - 26 * HOUR));
    await hd.reply(tx, vikram, vpn.id, { body: "Thanks Arjun. Could you send me the client version from Settings → About? I'll push the newer profile meanwhile.", internal: false, files: [] }, new Date(now - 25 * HOUR));
    await hd.reply(tx, vikram, vpn.id, { body: "Same issue reported by two others on the home ISP. Checking with the network vendor.", internal: true, files: [] }, new Date(now - 24 * HOUR));
    await hd.reply(tx, arjun, vpn.id, { body: "It's version 5.2.1. Happy to test the new profile.", internal: false, files: [] }, new Date(now - 23 * HOUR));

    // Sneha: address proof letter, answered and closed
    const letter = await hd.raiseTicket(tx, sneha, { categoryId: hr, title: "Address proof letter for bank account", description: "My bank needs a letter from the company confirming my current address. Could HR issue one?", files: [] }, new Date(now - 72 * HOUR));
    await hd.reply(tx, priya, letter.id, { body: "Done. You'll find the letter under Documents on your profile. Let me know if the bank needs anything else.", internal: false, files: [] }, new Date(now - 70 * HOUR));
    await hd.changeStatus(tx, priya, letter.id, "close", new Date(now - 69 * HOUR));

    // Imran: reimbursement, nobody has answered for two days (past both targets)
    await hd.raiseTicket(tx, imran, { categoryId: pay, title: "Travel reimbursement from last month not received", description: "I submitted my client visit travel claim on the 3rd but it wasn't in this month's salary. Could you check?", files: [] }, new Date(now - 6 * 24 * HOUR));

    // Meera: new mouse, Vikram left an internal note
    const mouse = await hd.raiseTicket(tx, meera, { categoryId: it, title: "Mouse scroll wheel broken", description: "The scroll wheel on my mouse stopped working. Can I get a replacement?", files: [] }, new Date(now - 3 * HOUR));
    await hd.reply(tx, vikram, mouse.id, { body: "We have spares in the store room; hand one over when Meera is in on Thursday.", internal: true, files: [] }, new Date(now - 2 * HOUR));

    // Divya: question during notice period
    await hd.raiseTicket(tx, divya, { categoryId: hr, title: "When will I get my relieving letter?", description: "My last working day is coming up. Will the relieving letter be emailed or shared on erp?", files: [] }, new Date(now - 1 * HOUR));

    // Rohan: closed, then reopened
    const access = await hd.raiseTicket(tx, rohan, { categoryId: it, title: "Can't open the staging dashboard", description: "Getting 'access denied' on the staging monitoring dashboard since this morning.", files: [] }, new Date(now - 50 * HOUR));
    await hd.reply(tx, vikram, access.id, { body: "Your access was renewed, please try again.", internal: false, files: [] }, new Date(now - 49 * HOUR));
    await hd.changeStatus(tx, vikram, access.id, "close", new Date(now - 48 * HOUR));
    await hd.changeStatus(tx, rohan, access.id, "reopen", new Date(now - 5 * HOUR));
    await hd.reply(tx, rohan, access.id, { body: "Worked for a day, now it's denied again.", internal: false, files: [] }, new Date(now - 5 * HOUR));
  });

  // ---------- assets ----------
  await withTenant(tenantId, async (tx) => {
    await assets.ensureAssetDefaults(tx, tenantId);
    const type = async (name: string) => (await tx<{ id: string }[]>`select id from asset_types where name = ${name}`)[0].id;
    const laptop = await type("Laptop"), monitor = await type("Monitor"), headset = await type("Headset"), idCard = await type("ID card");
    const P = (rupees: number) => BigInt(rupees) * BigInt(100);
    const items: [string, string, string, string | null, string | null, bigint | null, "new" | "good" | "fair"][] = [
      [laptop, "LAP-0001", "Dell Latitude 5440", "DL5440-7Q2K", "2025-04-10", P(84500), "good"],
      [laptop, "LAP-0002", "Dell Latitude 5440", "DL5440-8M1Z", "2025-04-10", P(84500), "good"],
      [laptop, "LAP-0003", "Lenovo ThinkPad E14", "TPE14-55AA", "2025-09-01", P(72000), "new"],
      [laptop, "LAP-0004", "Lenovo ThinkPad E14", "TPE14-55AB", "2025-09-01", P(72000), "good"],
      [laptop, "LAP-0005", "Apple MacBook Air 13", "C02XK1MBA", "2026-01-15", P(114900), "new"],
      [laptop, "LAP-0006", "HP ProBook 440", "HP440-19TR", "2024-06-20", P(61000), "fair"],
      [laptop, "LAP-0007", "Lenovo ThinkPad E14", "TPE14-55AC", "2025-09-01", P(72000), "new"],
      [monitor, "MON-0001", "Dell 24\" P2423", "P2423-001", "2025-04-10", P(16999), "good"],
      [monitor, "MON-0002", "Dell 24\" P2423", "P2423-002", "2025-04-10", P(16999), "good"],
      [monitor, "MON-0003", "LG 27\" 27UL500", "LG27-883", "2024-11-02", P(21500), "fair"],
      [headset, "HDS-0001", "Jabra Evolve2 30", null, "2025-07-01", P(6499), "new"],
      [headset, "HDS-0002", "Jabra Evolve2 30", null, "2025-07-01", P(6499), "new"],
      [idCard, "ID-0001", "Access card", null, null, P(250), "good"],
      [idCard, "ID-0002", "Access card", null, null, P(250), "good"],
      [idCard, "ID-0003", "Access card", null, null, P(250), "good"],
      [idCard, "ID-0004", "Access card", null, null, P(250), "good"],
    ];
    const tag: Record<string, string> = {};
    for (const [typeId, t, name, serial, bought, cost, condition] of items) {
      tag[t] = (await assets.saveAsset(tx, asha, null, { typeId, tag: t, name, serialNumber: serial, condition, purchaseDate: bought, costPaise: cost })).id;
    }
    const day = (n: number) => new Date(now - n * 24 * HOUR);
    const give = async (who: Actor, tags: string[], when: Date, by: Actor = priya) => assets.assignAssets(tx, by, { assetIds: tags.map((t) => tag[t]), employeeId: who.employeeId, notes: null }, when);
    const r1 = await give(rohan, ["LAP-0001", "ID-0001"], day(300));
    const r2 = await give(arjun, ["LAP-0002", "ID-0002"], day(200));
    await give(meera, ["LAP-0003"], day(2));
    await give(divya, ["LAP-0004", "ID-0004"], day(150));
    await give(priya, ["LAP-0005", "MON-0001"], day(90), asha);     // HR can't hand assets to themselves
    for (const id of [...r1.assignmentIds, ...r2.assignmentIds]) {
      await tx`update asset_assignments set acknowledged_at = assigned_at + interval '1 hour' where id = ${id}`;
    }
    // Vikram returned an old laptop with a cracked hinge; ₹2,500 recorded for recovery
    const v = await give(vikram, ["LAP-0006"], day(400));
    await assets.returnAssets(tx, priya, [{ assignmentId: v.assignmentIds[0], condition: "damaged", recoveryPaise: P(2500), notes: "Cracked hinge on the left side" }], day(30));
    const v2 = await give(vikram, ["LAP-0007", "ID-0003"], day(30));
    await tx`update asset_assignments set acknowledged_at = assigned_at + interval '2 hours' where id = any(${v2.assignmentIds}::uuid[])`;
    await assets.saveAsset(tx, asha, tag["MON-0003"], { typeId: monitor, tag: "MON-0003", name: "LG 27\" 27UL500", serialNumber: "LG27-883", condition: "fair", status: "in_repair", purchaseDate: "2024-11-02", costPaise: P(21500) });

    // requests: Imran waits for Sneha's approval; Meera's headset was approved by Rohan and needs handing over
    await assets.requestAsset(tx, imran, { typeId: monitor, kind: "new", reason: "A second screen would help with the CRM and email side by side." });
    const m = await assets.requestAsset(tx, meera, { typeId: headset, kind: "new", reason: "For client calls from the open office." });
    const [step] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${m.id} and s.status = 'pending'`;
    if (step) await decide(tx, rohan, step.id, "approved", "Sure");
  });
}
