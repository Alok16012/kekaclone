import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myTax } from "@/server/modules/tax/service";
import { myFbp } from "@/server/modules/tax/fbp";
import { fyStartFromLabel, fyStartOf } from "@/server/modules/tax/rules";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { UnverifiedRatesBanner } from "@/features/statutory/rates-banner";
import { MyTaxView } from "@/features/tax/my-tax";

export const metadata: Metadata = { title: "Income tax" };

const TABS = ["overview", "deductions", "house", "other", "fbp", "proofs", "forms"] as const;

export default async function MyTaxPage(props: PageProps<"/me/tax">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const today = todayIn();
    const fy = (typeof sp.fy === "string" && fyStartFromLabel(sp.fy)) || fyStartOf(today);
    return { ...(await myTax(tx, actor, fy, today)), fbp: await myFbp(tx, actor, fy, today) };
  });
  const tab = TABS.find((t) => t === sp.tab) ?? "overview";
  return (
    <>
      <PageHeader title="Income tax" description="Choose your tax regime, declare investments and rent, and send proofs, so the right tax is taken from your salary." />
      <div className="mb-6"><UnverifiedRatesBanner status={d.rates} link={false} /></div>
      <MyTaxView d={d} tab={tab} fbp={d.fbp} />
    </>
  );
}
