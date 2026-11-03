import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { preboardingBoard } from "@/server/modules/hire/offers";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { Preboarding } from "@/features/hire/preboarding";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "Offers & joining" };

export default async function OffersPage() {
  const d = await load(async (tx, actor) => {
    const tabs = await hireTabs(tx, actor);
    return { tabs, offers: tabs.offers ? await preboardingBoard(tx, actor) : null };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="Offers & joining" description="Offers waiting for approval or an answer, and joiners' documents and tasks." />
      {!d.offers ? <Card><EmptyState title="You're not on any hiring team" /></Card> : <Preboarding offers={d.offers} />}
    </>
  );
}
