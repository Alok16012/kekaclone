import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";

export function NoAccess({ what }: { what: string }) {
  return <Card><EmptyState icon={<ShieldOff />} title="You don't have access" description={`${what} is for performance admins. Ask HR if you need it.`} action={<Button variant="secondary" asChild><Link href="/me/performance">Back to my goals</Link></Button>} /></Card>;
}
