"use client";
import { RouteError } from "@/features/route-error";

export default function ErrorBoundary({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load the expense desk" retry={retry} />;
}
