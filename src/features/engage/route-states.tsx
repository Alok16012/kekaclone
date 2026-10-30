"use client";
import { RefreshCw } from "lucide-react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/** Error boundary body for Home and the Engage pages: plain message and a retry. */
export function RouteError({ title, reset }: { title: string; reset: () => void }) {
  return (
    <Card>
      <EmptyState title={title} description="Something went wrong while loading this page. It's usually temporary."
        action={<Button variant="secondary" onClick={reset}><RefreshCw />Try again</Button>} />
    </Card>
  );
}
