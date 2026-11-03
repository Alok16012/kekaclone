"use client";
import { RouteError } from "@/features/route-error";

/** Catch-all for signed-in pages without their own boundary: a page that refuses access or fails shows this instead of a bare error. */
export default function ErrorBoundary({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load this page" retry={retry} />;
}
