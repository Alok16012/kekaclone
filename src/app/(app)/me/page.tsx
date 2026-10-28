import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/session";

/** /me is a shortcut to your own profile. */
export default async function MePage() {
  const actor = await requireActor();
  redirect(`/people/${actor.employeeId}`);
}
