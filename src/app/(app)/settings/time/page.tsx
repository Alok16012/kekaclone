import { redirect } from "next/navigation";

export default function TimeSettingsIndex() {
  redirect("/settings/time/shifts");
}
