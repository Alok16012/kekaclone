import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { z } from "zod";
import { load } from "@/server/page-data";
import { listInvoices, listProjects } from "@/server/modules/psa/service";
import { canAdminPsa, canBill, canSeePsa } from "@/server/modules/psa/access";
import { todayIn } from "@/lib/dates";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { PsaDesk } from "@/features/psa/desk";
import { Billing, type InvoiceListRow } from "@/features/psa/billing";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage(props: PageProps<"/psa/billing">) {
  const sp = await props.searchParams;
  const initialProject = typeof sp.project === "string" && z.uuid().safeParse(sp.project).success ? sp.project : null;
  const d = await load(async (tx, actor) => {
    const projects = await listProjects(tx, actor);
    const access = { admin: canAdminPsa(actor), billing: canBill(actor), approver: projects.some((p) => p.approver) };
    if (!canSeePsa(actor)) return { access, invoices: null, projects: [], today: todayIn() };
    const invoices = await listInvoices(tx, actor);
    return {
      access, today: todayIn(),
      invoices: invoices.map((i): InvoiceListRow => ({ id: i.id, number: i.number, client: i.client, project: i.project, period_from: i.period_from, period_to: i.period_to, subtotal_paise: Number(i.subtotal_paise), tax_paise: Number(i.tax_paise), status: i.status, issued_on: i.issued_on, due_on: i.due_on, paid_on: i.paid_on })),
      projects: projects.filter((p) => p.billing_model !== "non_billable" && p.client_id && p.status !== "archived").map((p) => ({ id: p.id, name: p.name, code: p.code, billing_model: p.billing_model, client: p.client, uninvoiced_minutes: p.uninvoiced_minutes })),
    };
  });
  return (
    <>
      <PsaDesk access={d.access} title="Billing" description="Invoices raised from approved hours, retainers and finished milestones." />
      {d.invoices ? <Billing invoices={d.invoices} projects={d.projects} canBill={d.access.billing} initialProject={d.access.billing ? initialProject : null} today={d.today} />
        : <Card><EmptyState icon={<Lock />} title="Billing is for finance and project admins" description="Ask an admin for the billing role if you need this." /></Card>}
    </>
  );
}
