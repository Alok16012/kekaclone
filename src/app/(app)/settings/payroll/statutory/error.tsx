"use client";
import { RouteError } from "@/features/route-error";

export default function StatutoryError({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load the statutory rates" retry={retry} />;
}
