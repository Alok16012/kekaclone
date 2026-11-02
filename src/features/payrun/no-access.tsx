import { ShieldOff } from "lucide-react";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/** In place of a payroll run screen for people who don't run payroll for the whole company. */
export function PayrunNoAccess() {
  return (
    <Card>
      <EmptyState icon={<ShieldOff />} title="You don't have access to payroll runs"
        description="Running payroll needs company-wide payroll access. Ask your payroll or HR admin if you think you should have it." />
    </Card>
  );
}
