"use client";
import * as React from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";

/** Shared error boundary body for the attendance, team and time-settings routes. */
export function RouteError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  React.useEffect(() => { console.error(error); }, [error]);
  return (
    <Card>
      <EmptyState icon={<TriangleAlert />} title={`We couldn't load ${what}`} description="This is on our side. Try again in a moment; your data is safe."
        action={<Button variant="secondary" onClick={() => retry()}><RotateCw />Try again</Button>} />
    </Card>
  );
}
