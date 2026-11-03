import "server-only";
import type { Tx } from "@/server/db";
import { digestEmail } from "@/server/email/templates";
import { appUrl, queueEmail } from "@/server/email";
import { channelsFor } from "@/server/modules/notifications/events";

/**
 * Daily approvers' digest: one email per person with the requests waiting for their decision, only when the
 * "approvals.digest" event is emailed (Settings → Notifications). Once a day per person, so re-running is harmless.
 * Run by pnpm jobs:daily (step approval_digest) or pnpm jobs:digest.
 */
const KIND = "approvals.digest";
const timeAgo = (d: Date, now: Date) => {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
};
const LABEL: Record<string, string> = { leave: "Leave", attendance_request: "Attendance", profile_change: "Profile", comp_off: "Comp-off", exit: "Exit", expense_claim: "Expense", expense_advance: "Advance", asset_request: "Asset", loan: "Loan", requisition: "Requisition", offer: "Offer", comp_proposal: "Increment", timesheet: "Timesheet" };

/** The digest for one tenant inside a transaction (the smoke test rolls it back). */
export async function digestIn(tx: Tx, tenantId: string, now = new Date()) {
  {
    const [setting] = await tx<{ channels: string[] }[]>`select channels from notification_settings where event = ${KIND}`;
    if (!channelsFor(KIND, setting?.channels as ("in_app" | "email")[] | undefined).includes("email")) return { approvers: 0, sent: 0, skipped: 0 };
    const [t] = await tx<{ name: string; subdomain: string }[]>`select name, subdomain::text from tenants where id = ${tenantId}`;
    const rows = await tx<{ approver_id: string; name: string; email: string; entity_type: string; summary: string; created_at: Date }[]>`
      select e.id as approver_id, e.display_name as name, u.email::text as email, r.entity_type, r.summary, r.created_at
      from approval_steps s join approval_requests r on r.id = s.request_id
      join employees e on e.id = s.approver_employee_id join users u on u.id = e.user_id and u.status = 'active'
      where s.status = 'pending' and e.status <> 'relieved' order by e.display_name, r.created_at`;
    const by = new Map<string, { name: string; email: string; items: { kind: string; summary: string; ago: string }[] }>();
    for (const r of rows) {
      const g = by.get(r.approver_id) ?? { name: r.name, email: r.email, items: [] };
      g.items.push({ kind: LABEL[r.entity_type] ?? r.entity_type, summary: r.summary, ago: timeAgo(r.created_at, now) });
      by.set(r.approver_id, g);
    }
    let sent = 0, skipped = 0;
    for (const g of by.values()) {
      const [already] = await tx`select 1 from outbound_emails where kind = ${KIND} and to_email = ${g.email} and created_at >= (${now}::timestamptz at time zone 'Asia/Kolkata')::date::timestamp at time zone 'Asia/Kolkata'`;
      if (already) { skipped++; continue; }
      await queueEmail(tx, tenantId, { kind: KIND, to: g.email, ...digestEmail({ company: t.name, name: g.name, url: appUrl(t.subdomain, "/inbox"), items: g.items }) });
      sent++;
    }
    return { approvers: by.size, sent, skipped };
  }
}

