"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/ui/app-shell";

const TABS = [
  { href: "/psa/projects", label: "Projects", key: "projects" },
  { href: "/psa/clients", label: "Clients", key: "clients" },
  { href: "/psa/approvals", label: "Approvals", key: "approvals" },
  { href: "/psa/billing", label: "Billing", key: "billing" },
  { href: "/settings/timesheets", label: "Timesheet policy", key: "policy" },
] as const;

export type DeskAccess = { admin: boolean; billing: boolean; approver: boolean };

/** Shared header for the projects desk: tabs for what the person may open. */
export function PsaDesk({ access, title = "Projects", description, actions }: { access: DeskAccess; title?: string; description?: string; actions?: React.ReactNode }) {
  const path = usePathname();
  const show = (k: (typeof TABS)[number]["key"]) => k === "projects" || (k === "approvals" ? access.approver || access.admin : k === "billing" ? access.billing || access.admin : access.admin);
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <nav aria-label="Projects desk" className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((t) => show(t.key)).map((t) => {
          const active = path === t.href || path.startsWith(t.href + "/");
          return (
            <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}
              className={cn("-mb-px h-10 shrink-0 border-b-2 px-3 text-base font-medium leading-10 text-text-muted hover:text-text", active ? "border-accent text-text" : "border-transparent")}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
