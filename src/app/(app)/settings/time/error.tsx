"use client";
import { RouteError } from "@/features/attendance/route-error";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} what="time settings" />;
}
