import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { personAssets, requestableTypes } from "@/server/modules/assets/service";
import { PageHeader } from "@/ui/app-shell";
import { PersonAssets, RequestAsset } from "@/features/assets/person-assets";
import { toPersonAssetsDTO } from "@/features/assets/dto";

export const metadata: Metadata = { title: "My assets" };

export default async function MyAssetsPage(props: PageProps<"/me/assets">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [mine, types] = await Promise.all([personAssets(tx, actor, actor.employeeId), requestableTypes(tx)]);
    return { mine: toPersonAssetsDTO(mine!), types, name: actor.name };
  });
  return (
    <>
      <PageHeader title="My assets" description="Equipment the company has given you, and requests for anything new."
        actions={d.types.length ? <RequestAsset types={d.types} defaultOpen={sp.request === "1"} /> : undefined} />
      <PersonAssets data={d.mine} name={d.name} />
    </>
  );
}
