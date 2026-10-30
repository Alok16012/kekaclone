import { ShieldOff } from "lucide-react";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/** Shown in place of a payroll admin screen when the person lacks the permission. */
export function PayrollNoAccess({ scoped }: { scoped?: boolean }) {
  return (
    <Card>
      <EmptyState icon={<ShieldOff />} title="You don't have access to payroll settings"
        description={scoped ? "Your payroll access covers some teams only. Company-wide payroll setup is for payroll admins of the whole company." : "Payroll admins manage these. Ask your HR or finance team if you need a change."} />
    </Card>
  );
}
