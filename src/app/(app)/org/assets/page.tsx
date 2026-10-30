import type { Metadata } from "next";
import { Package } from "lucide-react";
import { load } from "@/server/page-data";
import { canFor, type Placement } from "@/server/auth/permissions";
import { ASSETS_ADMIN, canManageInventory, hasAssetsAccess, inventory, requestsQueue, structure } from "@/server/modules/assets/service";
import { AssetsAdmin } from "@/features/assets/assets-admin";
import { toRequestDTO } from "@/features/assets/dto";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Assets" };

export default async function AssetsPage(props: PageProps<"/org/assets">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!hasAssetsAccess(actor)) return null;
    const [items, struct, requests, people] = await Promise.all([
      inventory(tx, actor), structure(tx), requestsQueue(tx, actor),
      tx<({ id: string; name: string; title: string | null; department: string | null } & Placement)[]>`
        select e.id, e.display_name as name, d.title, dp.name as department, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
        from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
        where e.status <> 'relieved' and e.id <> ${actor.employeeId} order by e.display_name`,
    ]);
    const inScope = new Set(people.filter((p) => canFor(actor, ASSETS_ADMIN, p)).map((p) => p.id));
    return {
      canEdit: canManageInventory(actor),
      people: people.filter((p) => inScope.has(p.id)).map((p) => ({ id: p.id, name: p.name, title: p.title, department: p.department })),
      structure: struct,
      requests: requests.map(toRequestDTO),
      assets: items.map((a) => ({
        id: a.id, tag: a.tag, name: a.name, serial_number: a.serial_number, condition: a.condition, status: a.status, purchase_date: a.purchase_date,
        cost_paise: a.cost_paise == null ? null : a.cost_paise.toString(), type_id: a.type_id, type: a.type, category: a.category, requires_ack: a.requires_ack,
        assignment_id: a.assignment_id, holder_id: a.holder_id, holder: a.holder, assigned_at: a.assigned_at?.toISOString() ?? null, acknowledged_at: a.acknowledged_at?.toISOString() ?? null,
        can_return: !!a.holder_id && inScope.has(a.holder_id),
      })),
    };
  });
  if (!d) {
    return (
      <>
        <PageHeader title="Assets" />
        <Card><EmptyState icon={<Package />} title="Assets are managed by HR and IT" description="To see what's issued to you or ask for something, open My assets." /></Card>
      </>
    );
  }
  const tab = typeof sp.tab === "string" && ["inventory", "requests", "types"].includes(sp.tab) ? sp.tab : "inventory";
  return <AssetsAdmin {...d} initialTab={tab} />;
}
