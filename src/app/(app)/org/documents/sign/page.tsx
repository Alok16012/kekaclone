import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { signatureTracking } from "@/server/modules/documents/esign";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { SignTracking } from "@/features/documents/esign-ui";

export const metadata: Metadata = { title: "Signature requests" };

export default async function SignTrackingPage() {
  const rows = await load(async (tx, actor) => {
    try { return await signatureTracking(tx, actor); } catch (e) { if (e instanceof AppError && e.code === "forbidden") return null; throw e; }
  });
  if (!rows) return <Card><EmptyState icon={<ShieldAlert />} title="Signature tracking is for people who manage documents" description="Ask an admin for the “Manage company documents” permission." /></Card>;
  return (
    <>
      <PageHeader title="erp Sign" description="Who has signed what, and who is holding things up." breadcrumb="Documents" />
      <SignTracking rows={rows.map((r) => ({ ...r, requested_at: r.requested_at.toISOString() }))} />
    </>
  );
}
