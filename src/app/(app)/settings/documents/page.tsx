import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canManageDocs } from "@/server/modules/documents/service";
import { listTemplates } from "@/server/modules/documents/letters";
import { LetterTemplates } from "@/features/settings/letter-templates";

export const metadata: Metadata = { title: "Letter templates" };

export default async function DocumentSettingsPage() {
  const d = await load(async (tx, actor) => ({ templates: await listTemplates(tx), canEdit: canManageDocs(actor) }));
  return <LetterTemplates canEdit={d.canEdit} templates={d.templates.map((t) => ({ ...t, updated_at: t.updated_at.toISOString() }))} />;
}
