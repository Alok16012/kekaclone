"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/performance", label: "Review cycles", admin: true },
  { href: "/performance/okr-tree", label: "Alignment tree" },
  { href: "/performance/insights", label: "Goal insights" },
  { href: "/performance/feedback", label: "Feedback summary", admin: true },
  { href: "/performance/settings/skills", label: "Skills library", admin: true },
  { href: "/performance/settings", label: "Settings", admin: true },
];

/** Section links for the performance admin area. Managers without admin rights see the tree and insights only. */
export function AdminPerfNav({ admin }: { admin: boolean }) {
  const path = usePathname();
  return (
    <nav aria-label="Performance admin" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
      {LINKS.filter((l) => admin || !l.admin).map((l) => {
        const active = l.href === "/performance" ? path === l.href || path.startsWith("/performance/cycles") : l.href === "/performance/settings" ? path === l.href : path === l.href || path.startsWith(l.href + "/");
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
            className={cn("-mb-px inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-3 text-base font-medium whitespace-nowrap text-text-muted hover:text-text", active && "border-accent text-text")}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
