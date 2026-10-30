import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canManageDocs, libraryFor, pendingAcks } from "@/server/modules/documents/service";
import { DocumentLibrary } from "@/features/documents/library";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage() {
  const d = await load(async (tx, actor) => {
    const manage = canManageDocs(actor);
    const [folders, pending, departments, locations] = await Promise.all([
      libraryFor(tx, actor), pendingAcks(tx, actor),
      manage ? tx<{ id: string; name: string }[]>`select id, name from departments order by name` : Promise.resolve([]),
      manage ? tx<{ id: string; name: string }[]>`select id, name from locations order by name` : Promise.resolve([]),
    ]);
    return { manage, folders, pending: pending.length, departments, locations };
  });
  const folders = d.folders.map((f) => ({
    ...f, docs: f.docs.map((x) => ({ ...x, created_at: x.created_at.toISOString(), viewed_at: x.viewed_at?.toISOString() ?? null, acknowledged_at: x.acknowledged_at?.toISOString() ?? null })),
  }));
  return <DocumentLibrary folders={folders} manage={d.manage} departments={d.departments} locations={d.locations} pending={d.pending} />;
}
