"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CourseDialog } from "./admin-courses";

/** /learn/admin/courses/new: the create dialog, open straight away; closing it goes back to the list. */
export function NewCourse() {
  const router = useRouter();
  const [open, setOpen] = React.useState(true);
  if (!open) return null;
  return <CourseDialog onClose={() => { setOpen(false); router.push("/learn/admin"); }} />;
}
