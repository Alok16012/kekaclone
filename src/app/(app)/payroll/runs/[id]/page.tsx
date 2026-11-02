import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { runView } from "@/server/modules/payrun/runs";
import { PayrunNoAccess } from "@/features/payrun/no-access";
import { RunWizard } from "@/features/payrun/run-wizard";

export const metadata: Metadata = { title: "Payroll run" };

export default async function RunPage(props: PageProps<"/payroll/runs/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!canRunPayroll(actor)) return { denied: true as const };
    try { return { denied: false as const, view: await runView(tx, actor, id) }; } catch (e) {
      if (e instanceof AppError && e.code === "not_found") return { denied: false as const, view: null };
      throw e;
    }
  });
  if (d.denied) return <PayrunNoAccess />;
  if (!d.view) notFound();
  return <RunWizard key={d.view.run.id} d={d.view} initialStep={typeof sp.step === "string" ? sp.step : null} />;
}
