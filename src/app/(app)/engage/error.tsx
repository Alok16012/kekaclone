"use client";
import { RouteError } from "@/features/engage/route-states";

export default function ErrorBoundary({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load this page" reset={retry} />;
}
