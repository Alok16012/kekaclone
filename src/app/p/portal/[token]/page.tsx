import type { Metadata } from "next";
import { Suspense } from "react";
import { withTenant } from "@/server/db";
import { portalView } from "@/server/modules/hire/offers";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { Portal } from "@/features/hire/public/portal";
import { publicTenant } from "@/app/careers/tenant";

export const metadata: Metadata = { title: "Your offer" };

async function Body({ params }: { params: PageProps<"/p/portal/[token]">["params"] }) {
  const { token } = await params;
  const t = await publicTenant();
  const v = t ? await withTenant(t.id, (tx) => portalView(tx, token)) : null;
  if (!v) return <Card><EmptyState title="This link doesn't work any more" description="Links stop working after 30 days or when a newer one is sent. Ask the hiring team to send you a new link." /></Card>;
  return <Portal token={token} view={v} />;
}

export default function PortalPage(props: PageProps<"/p/portal/[token]">) {
  return <Suspense fallback={<Skeleton className="h-96" />}><Body params={props.params} /></Suspense>;
}
