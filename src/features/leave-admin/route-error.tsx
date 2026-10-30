"use client";
import * as React from "react";
import Link from "next/link";
import { CloudAlert, ShieldOff } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";

/** Error boundary body for the leave screens: friendly message, try again, and a way out. */
export function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  React.useEffect(() => { console.error(error); }, [error]);
  return (
    <Card role="alert">
      <EmptyState icon={<CloudAlert />} title="This page didn't load"
        description="Something went wrong on our side. Your data is safe. Try again, and if it keeps happening, let us know."
        action={<div className="flex flex-wrap justify-center gap-2"><Button onClick={() => retry()}>Try again</Button><Button asChild variant="secondary"><Link href="/home">Go home</Link></Button></div>} />
    </Card>
  );
}

/** Shown in place of an admin screen when the person lacks the permission. */
export function NoAccess({ what = "leave settings" }: { what?: string }) {
  return (
    <Card>
      <EmptyState icon={<ShieldOff />} title={`You don't have access to ${what}`} description="Leave admins manage these. Ask your HR team if you need to change something." />
    </Card>
  );
}
