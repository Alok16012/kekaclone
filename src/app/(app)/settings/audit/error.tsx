"use client";
import { RouteError } from "@/features/route-error";

export default function AuditError({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load the audit log" retry={retry} />;
}
