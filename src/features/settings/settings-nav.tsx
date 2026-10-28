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
  ] },
  { group: "Access", links: [{ href: "/settings/roles", label: "Roles & permissions" }] },
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
