import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/session";

/** /me/id-card is a shortcut to your own digital ID card. */
export default async function MyIdCardPage() {
  const actor = await requireActor();
  redirect(`/people/${actor.employeeId}/id-card`);
}
