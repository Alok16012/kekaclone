"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { group: "Company structure", links: [
    { href: "/settings/org/departments", label: "Departments" },
    { href: "/settings/org/designations", label: "Designations" },
    { href: "/settings/org/locations", label: "Locations" },
    { href: "/settings/org/legal_entities", label: "Legal entities" },
    { href: "/settings/org/business_units", label: "Business units" },
    { href: "/settings/org/bands", label: "Bands" },
    { href: "/settings/groups", label: "Groups & probation" },
    { href: "/settings/custom-fields", label: "Custom fields" },
  ] },
  { group: "Access", links: [{ href: "/settings/roles", label: "Roles & permissions" }, { href: "/settings/security", label: "Sign-in security" }, { href: "/settings/audit", label: "Audit log" }, { href: "/settings/approvals", label: "Approvals" }, { href: "/settings/jobs", label: "Scheduled jobs" }] },
  { group: "Leave", links: [
    { href: "/settings/leave/plans", label: "Leave plans" },
    { href: "/settings/leave/types", label: "Leave types" },
    { href: "/settings/leave/balances", label: "Leave balances" },
    { href: "/settings/leave/grants", label: "Event-based leave" },
    { href: "/settings/leave/year-end", label: "Leave year end" },
    { href: "/settings/holidays", label: "Holidays" },
  ] },
  { group: "Time", links: [
    { href: "/settings/time/shifts", label: "Shifts" },
    { href: "/settings/time/weekly-offs", label: "Weekly offs" },
    { href: "/settings/time/capture", label: "Clock-in rules" },
    { href: "/settings/time/penalties", label: "Penalties" },
    { href: "/settings/time/assignments", label: "Assignments" },
    { href: "/settings/time/roster", label: "Roster" },
    { href: "/settings/time/shift-rules", label: "Shift change rules" },
    { href: "/settings/time/overtime", label: "Overtime & allowances" },
    { href: "/settings/time/devices", label: "Devices" },
  ] },
  { group: "Notifications", links: [{ href: "/settings/notifications", label: "Events & emails" }, { href: "/settings/notifications/templates", label: "Email templates" }] },
  { group: "Automations", links: [{ href: "/settings/automations", label: "Workflow automations" }] },
  { group: "Payroll", links: [
    { href: "/settings/payroll/components", label: "Salary components" },
    { href: "/settings/payroll/pay-groups", label: "Pay groups" },
    { href: "/settings/payroll/structures", label: "Salary structures" },
    { href: "/settings/payroll/revisions", label: "Salary revisions" },
    { href: "/settings/payroll/statutory", label: "Statutory rates" },
    { href: "/settings/payroll/loans", label: "Loan types" },
  ] },
  { group: "Finance", links: [{ href: "/settings/expenses", label: "Expenses" }] },
  { group: "Lifecycle", links: [{ href: "/settings/tasks", label: "Onboarding tasks" }, { href: "/settings/exits", label: "Exits & notice periods" }, { href: "/settings/exit-survey", label: "Exit survey" }, { href: "/settings/documents", label: "Documents" }] },
  { group: "Home", links: [{ href: "/settings/quick-links", label: "Quick links" }] },
  { group: "Service desk", links: [{ href: "/settings/helpdesk", label: "Helpdesk" }] },
  { group: "Workspace", links: [
    { href: "/settings/billing", label: "Billing & plan" },
    { href: "/settings/branding", label: "Branding" },
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/api", label: "API & webhooks" },
    { href: "/developers", label: "Developer guide" },
  ] },
  { group: "Hiring", links: [{ href: "/settings/hire", label: "Hiring" }] },
  { group: "Performance", links: [{ href: "/performance/settings", label: "Performance" }, { href: "/performance/settings/skills", label: "Skills library" }] },
  { group: "Projects", links: [{ href: "/settings/timesheets", label: "Timesheet policy" }] },
];

/** Vertical on desktop, horizontally scrolling chips on mobile. */
export function SettingsNav() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="lg:w-56 lg:shrink-0">
      <div className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:gap-5 lg:overflow-visible lg:pb-0">
        {ITEMS.map((g) => (
          <div key={g.group} className="contents lg:block">
            <p className="hidden px-3 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted lg:block">{g.group}</p>
            <ul className="contents lg:flex lg:flex-col lg:gap-0.5">
              {g.links.map((l) => {
                const active = path === l.href || path.startsWith(l.href + "/");
                return (
                  <li key={l.href} className="shrink-0">
                    <Link href={l.href} aria-current={active ? "page" : undefined}
                      className={cn("block rounded-md px-3 py-1.5 text-base whitespace-nowrap text-text-muted hover:bg-surface-hover hover:text-text",
                        active && "bg-sidebar-active font-medium text-sidebar-active-text hover:bg-sidebar-active hover:text-sidebar-active-text")}>
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
