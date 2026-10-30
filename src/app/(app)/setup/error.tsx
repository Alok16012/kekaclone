"use client";
import { RouteError } from "@/features/route-error";

export default function SetupError({ retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="We couldn't load company setup" retry={retry} />;
}
