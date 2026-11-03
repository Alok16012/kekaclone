import Link from "next/link";
import { connection } from "next/server";
import { Lock } from "lucide-react";
import { getActor } from "@/server/auth/session";
import { canWorkspace } from "@/server/modules/saas/gate";
import { featureProblem, type Feature } from "@/server/modules/saas/plans";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/**
 * Plan gate for a whole section (hiring, performance): when the workspace's plan lacks the feature the pages are
 * replaced by one clear notice instead of rendering. Server actions check the same rule (runAction's `feature`).
 */
export async function FeatureGate({ feature, children }: { feature: Feature; children: React.ReactNode }) {
  await connection();
  const actor = await getActor();
  const problem = actor ? featureProblem(actor.tenant, feature) : null;
  if (!problem) return <>{children}</>;
  const billing = actor && canWorkspace(actor, "settings.billing");
  return (
    <Card>
      <EmptyState icon={<Lock />} title="Not on your plan yet" description={problem}
        action={billing ? <Button asChild><Link href="/settings/billing">Open Billing</Link></Button> : undefined} />
    </Card>
  );
}
