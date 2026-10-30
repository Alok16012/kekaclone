"use client";
import { RouteError } from "@/features/leave-admin/route-error";

export default function HolidaysError(props: { error: unknown; retry: () => void }) {
  return <RouteError {...props} />;
}
