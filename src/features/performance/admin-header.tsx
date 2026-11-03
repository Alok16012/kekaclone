import { PageHeader } from "@/ui/app-shell";
import { AdminPerfNav } from "./admin-nav";

/** Title + section links for the performance admin pages. */
export function AdminHeader({ title, description, admin, actions }: { title: string; description?: string; admin: boolean; actions?: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <AdminPerfNav admin={admin} />
    </>
  );
}
