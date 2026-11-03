"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/me/performance", label: "Goals" },
  { href: "/me/performance/feedback", label: "Feedback" },
  { href: "/me/performance/one-on-ones", label: "1:1s" },
  { href: "/me/performance/reviews", label: "Reviews" },
  { href: "/me/performance/skills", label: "Skills" },
  { href: "/me/performance/pip", label: "Plans" },
];

/** Section links for Me → Performance (horizontal, scrolls on small screens). */
export function PerfNav() {
  const path = usePathname();
  return (
    <nav aria-label="Performance" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
      {LINKS.map((l) => {
        const active = l.href === "/me/performance" ? path === l.href : path === l.href || path.startsWith(l.href + "/");
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
            className={cn("-mb-px inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-3 text-base font-medium whitespace-nowrap text-text-muted hover:text-text",
              active && "border-accent text-text")}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
