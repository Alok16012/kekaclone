import { redirect } from "next/navigation";

/** /psa opens the projects list. */
export default function PsaIndex() {
  redirect("/psa/projects");
}
