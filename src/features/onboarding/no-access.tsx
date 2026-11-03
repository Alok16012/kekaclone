import { ShieldAlert } from "lucide-react";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

export function NoAccess({ what }: { what: string }) {
  return (
    <Card>
      <EmptyState icon={<ShieldAlert />} title="You don't have access to this page" description={`${what} Ask an admin if you need access.`} />
    </Card>
  );
}
