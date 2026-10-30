"use client";
import { RouteError } from "@/features/attendance/route-error";

export default function PayrollSettingsError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} what="payroll settings" />;
}
