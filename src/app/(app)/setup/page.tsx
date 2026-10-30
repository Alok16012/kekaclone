import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { isGlobalAdmin, setupData } from "@/server/modules/setup/service";
import { isStep, nextStep } from "@/server/modules/setup/rules";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { SetupWizard } from "@/features/setup/setup-wizard";

export const metadata: Metadata = { title: "Company setup" };

export default async function SetupPage(props: PageProps<"/setup">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => (isGlobalAdmin(actor) ? setupData(tx, actor) : null));
  if (!d) {
    return (
      <Card className="mx-auto max-w-xl">
        <EmptyState icon={<ShieldAlert />} title="Company setup is for Global admins"
          description="Ask the person who created your workspace to finish setting it up."
          action={<Button asChild variant="secondary"><Link href="/home">Go to Home</Link></Button>} />
      </Card>
    );
  }
  const step = typeof sp.step === "string" && isStep(sp.step) ? sp.step : nextStep(d.state);
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Set up your company" description="A few basics so leave, attendance and payroll work from day one. Skip anything and come back later." />
      <SetupWizard data={d} initialStep={step} />
    </div>
  );
}
