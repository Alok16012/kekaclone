import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { fnfDetail } from "@/server/modules/payrun/fnf";
import { PayrunNoAccess } from "@/features/payrun/no-access";
import { SettlementView } from "@/features/payrun/settlement";

export const metadata: Metadata = { title: "Final settlement" };

export default async function SettlementPage(props: PageProps<"/payroll/settlements/[exitId]">) {
  const { exitId } = await props.params;
  if (!z.uuid().safeParse(exitId).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!canRunPayroll(actor)) return { denied: true as const };
    try { return { denied: false as const, view: await fnfDetail(tx, actor, exitId) }; } catch (e) {
      if (e instanceof AppError && e.code === "not_found") return { denied: false as const, view: null };
      throw e;
    }
  });
  if (d.denied) return <PayrunNoAccess />;
  if (!d.view) notFound();
  return <SettlementView d={d.view} />;
}
