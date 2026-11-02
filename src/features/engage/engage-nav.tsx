import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { cn } from "@/lib/cn";

/** Link tabs between the two Engage admin pages. */
export function EngageNav({ active }: { active: "announcements" | "polls" | "surveys" }) {
  const items = [{ key: "announcements", href: "/engage/announcements", label: "Announcements" }, { key: "polls", href: "/engage/polls", label: "Poll results" }, { key: "surveys", href: "/engage/surveys", label: "Surveys" }] as const;
  return (
    <nav aria-label="Engage" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={active === i.key ? "page" : undefined}
          className={cn("-mb-px inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-3 text-base font-medium text-text-muted hover:text-text",
            active === i.key && "border-accent text-text")}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function NoAccess() {
  return (
    <Card>
      <EmptyState icon={<ShieldAlert />} title="You don't have access to this page" description="Announcements and poll results are managed by HR. Ask an admin if you need access." />
    </Card>
  );
}
