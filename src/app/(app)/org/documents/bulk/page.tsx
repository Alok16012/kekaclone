import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { listBatches } from "@/server/modules/documents/bulk";
import { listTemplates } from "@/server/modules/documents/letters";
import { AppError } from "@/server/db";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { BulkLetters } from "@/features/documents/bulk-letters";

export const metadata: Metadata = { title: "Bulk letters" };

export default async function BulkLettersPage(props: PageProps<"/org/documents/bulk">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    try {
      const [batches, templates, departments, locations, designations] = await Promise.all([
        listBatches(tx, actor), listTemplates(tx),
        tx<{ value: string; label: string }[]>`select id as value, name as label from departments order by name`,
        tx<{ value: string; label: string }[]>`select id as value, name as label from locations order by name`,
        tx<{ value: string; label: string }[]>`select id as value, title as label from designations order by title`,
      ]);
      return { batches, templates: templates.map((t) => ({ value: t.id, label: t.name })), departments, locations, designations };
    } catch (e) { if (e instanceof AppError && e.code === "forbidden") return null; throw e; }
  });
  if (!d) return <Card><EmptyState icon={<ShieldAlert />} title="Bulk letters are for people who manage documents" description="Ask an admin for the “Manage company documents” permission." /></Card>;
  return (
    <>
      <PageHeader title="Bulk letters" description="Issue one letter template to many people at once, with a ZIP of every PDF." breadcrumb="Documents" />
      <BulkLetters batches={d.batches.map((b) => ({ ...b, created_at: b.created_at.toISOString(), finished_at: b.finished_at?.toISOString() ?? null }))}
        templates={d.templates} departments={d.departments} locations={d.locations} designations={d.designations} openId={typeof sp.batch === "string" ? sp.batch : null} />
    </>
  );
}
