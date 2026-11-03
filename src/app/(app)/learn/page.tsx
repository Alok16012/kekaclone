import { redirect } from "next/navigation";

/** /learn opens your own courses. */
export default function LearnIndex() {
  redirect("/me/learn");
}
