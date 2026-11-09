import type { Metadata } from "next";
import { Suspense } from "react";
import { withTenant } from "@/server/db";
import { signView } from "@/server/modules/documents/esign";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { SignPage } from "@/features/documents/sign-page";
import { publicTenant } from "@/app/careers/tenant";

export const metadata: Metadata = { title: "Sign a document" };

async function Body({ params }: { params: PageProps<"/sign/[token]">["params"] }) {
  const { token } = await params;
  const t = await publicTenant();
  const v = t ? await withTenant(t.id, (tx) => signView(tx, token)) : null;
  if (!v) return <Card><EmptyState title="This link doesn't work any more" description="Signing links stop working after 30 days, once the document is signed, or when a newer link is sent. Ask the sender for a new one." /></Card>;
  return <SignPage token={token} view={v} />;
}

export default function SignTokenPage(props: PageProps<"/sign/[token]">) {
  return <Suspense fallback={<Skeleton className="h-96" />}><Body params={props.params} /></Suspense>;
}
