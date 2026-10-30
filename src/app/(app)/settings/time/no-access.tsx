import { Lock } from "lucide-react";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

export function NoAccess() {
  return <Card><EmptyState icon={<Lock />} title="You don't have access to time settings" description="Ask an admin with attendance access if something here needs changing." /></Card>;
}
