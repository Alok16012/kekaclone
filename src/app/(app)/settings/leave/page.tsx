import { redirect } from "next/navigation";

export default function LeaveSettingsIndex() {
  redirect("/settings/leave/plans");
}
