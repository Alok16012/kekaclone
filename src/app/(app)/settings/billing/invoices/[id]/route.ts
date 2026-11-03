import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { canSeeBilling } from "@/server/modules/billing/service";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { formatINR } from "@/lib/money";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A GST invoice as PDF for one of the workspace's own billing invoices. Billing admins only. */
export async function GET(_req: Request, ctx: RouteContext<"/settings/billing/invoices/[id]">) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  if (!canSeeBilling(actor)) return new Response("Billing is for workspace admins.", { status: 403 });
  if (!z.uuid().safeParse(id).success) return new Response("Not found.", { status: 404 });
  const inv = await withTenant(actor.tenant.id, async (tx) => {
    const [i] = await tx<{ number: string; amount_paise: string; gst_paise: string; status: string; issued_at: Date; paid_at: Date | null; razorpay_payment_id: string | null; plan: string | null; seats: number | null; billing_cycle: string | null; gstin: string | null; name: string }[]>`
      select i.number, i.amount_paise::text, i.gst_paise::text, i.status, i.issued_at, i.paid_at, i.razorpay_payment_id, s.plan, s.seats, s.billing_cycle, t.billing->>'gstin' as gstin, t.name
      from billing_invoices i left join subscriptions s on s.id = i.subscription_id join tenants t on t.id = i.tenant_id where i.id = ${id}`;
    return i ?? null;
  });
  if (!inv) return new Response("Not found.", { status: 404 });
  const amount = Number(inv.amount_paise), gst = Number(inv.gst_paise);
  const d = (x: Date | null) => (x ? x.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
  const html = `
    <p><strong>Tax invoice ${esc(inv.number)}</strong></p>
    <p>Issued ${d(inv.issued_at)} · ${inv.status === "paid" ? `Paid ${d(inv.paid_at)}` : esc(inv.status)}${inv.razorpay_payment_id ? ` · Payment ${esc(inv.razorpay_payment_id)}` : ""}</p>
    <p>Billed to: ${esc(inv.name)}${inv.gstin ? ` · GSTIN ${esc(inv.gstin)}` : ""}</p>
    <p>Supplier: erp (SaaS subscription, HSN/SAC 998314)</p>
    <h3>Items</h3>
    <ul>
      <li>erp ${esc(inv.plan ?? "")} plan · ${inv.seats ?? "—"} employees · ${esc(inv.billing_cycle ?? "")}: ${formatINR(amount)}</li>
      <li>GST @ 18%: ${formatINR(gst)}</li>
    </ul>
    <p><strong>Total: ${formatINR(amount + gst)}</strong></p>
    <p>This is a computer-generated invoice.</p>`;
  const bytes = await renderLetterPdf({ html, title: `Invoice ${inv.number}`, company: "erp", footer: "erp · people, time and payroll in one place" });
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${inv.number}.pdf"`, "cache-control": "private, no-store" } });
}
