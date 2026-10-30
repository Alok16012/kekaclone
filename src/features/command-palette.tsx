"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import {
  BriefcaseBusiness, CalendarDays, CalendarPlus, Clock, CornerDownLeft, FileSpreadsheet, FileText, History, Home, Inbox, LayoutDashboard,
  LayoutGrid, LifeBuoy, Mail, Receipt, Search, Settings, ShieldCheck, Target, User, UserPlus, Users, Wallet,
} from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/ui/app-shell";
import type { PersonHit } from "@/server/modules/employees/service";
import { searchPeopleAction } from "@/app/(app)/actions";

type Item = { id: string; kind: "page" | "action" | "person" | "recent"; label: string; hint?: string; href: string; icon?: React.ReactNode; keywords?: string; admin?: boolean; person?: PersonHit };

const PAGES: Item[] = [
  { id: "p-home", kind: "page", label: "Home", href: "/home", icon: <Home />, keywords: "dashboard feed start" },
  { id: "p-inbox", kind: "page", label: "Inbox", href: "/inbox", icon: <Inbox />, keywords: "approvals requests pending" },
  { id: "p-att", kind: "page", label: "Attendance", href: "/me/attendance", icon: <Clock />, keywords: "clock in out logs timesheet punch" },
  { id: "p-leave", kind: "page", label: "Leave", href: "/me/leave", icon: <CalendarDays />, keywords: "holiday time off balance chhutti" },
  { id: "p-pay", kind: "page", label: "My finances", href: "/me/pay", icon: <Wallet />, keywords: "payslip salary tax" },
  { id: "p-exp", kind: "page", label: "Expenses", href: "/me/expenses", icon: <Receipt />, keywords: "claims reimbursement" },
  { id: "p-perf", kind: "page", label: "Performance", href: "/me/performance", icon: <Target />, keywords: "goals okr review feedback" },
  { id: "p-help", kind: "page", label: "Helpdesk", href: "/me/helpdesk", icon: <LifeBuoy />, keywords: "ticket question support" },
  { id: "p-me", kind: "page", label: "My profile", href: "/me", icon: <User />, keywords: "profile details address" },
  { id: "p-people", kind: "page", label: "People", href: "/org/employees", icon: <LayoutGrid />, keywords: "directory employees staff" },
  { id: "p-team", kind: "page", label: "My team", href: "/team", icon: <Users />, keywords: "reportees" },
  { id: "p-docs", kind: "page", label: "Documents", href: "/org/documents", icon: <FileText />, keywords: "policies letters" },
  { id: "p-dash", kind: "page", label: "Dashboard", href: "/org/dashboard", icon: <LayoutDashboard />, keywords: "headcount overview hr", admin: true },
  { id: "p-hire", kind: "page", label: "Hiring", href: "/hire/jobs", icon: <BriefcaseBusiness />, keywords: "jobs candidates recruit", admin: true },
  { id: "p-set", kind: "page", label: "Settings", href: "/settings", icon: <Settings />, keywords: "configuration", admin: true },
  { id: "p-org", kind: "page", label: "Company structure", hint: "Settings", href: "/settings/org/departments", icon: <Settings />, keywords: "departments designations locations bands legal entities", admin: true },
  { id: "p-roles", kind: "page", label: "Roles & permissions", hint: "Settings", href: "/settings/roles", icon: <ShieldCheck />, keywords: "access admin", admin: true },
  { id: "p-sec", kind: "page", label: "Sign-in security", hint: "Settings", href: "/settings/security", icon: <ShieldCheck />, keywords: "otp code 2fa mfa password", admin: true },
  { id: "p-audit", kind: "page", label: "Audit log", hint: "Settings", href: "/settings/audit", icon: <History />, keywords: "history changes who did logins sign-ins compliance", admin: true },
  { id: "p-setup", kind: "page", label: "Company setup", hint: "Getting started", href: "/setup", icon: <Settings />, keywords: "wizard onboarding first run checklist", admin: true },
];
const ACTIONS: Item[] = [
  { id: "a-leave", kind: "action", label: "Apply for leave", href: "/me/leave?apply=1", icon: <CalendarPlus />, keywords: "request time off chhutti" },
  { id: "a-clock", kind: "action", label: "Clock in or out", href: "/me/attendance", icon: <Clock />, keywords: "punch attendance" },
  { id: "a-add", kind: "action", label: "Add an employee", href: "/org/employees/new", icon: <UserPlus />, keywords: "new hire joiner", admin: true },
  { id: "a-import", kind: "action", label: "Import people from Excel", href: "/org/employees/import", icon: <FileSpreadsheet />, keywords: "bulk upload xlsx", admin: true },
  { id: "a-invite", kind: "action", label: "Invite people", hint: "Select them in People", href: "/org/employees", icon: <Mail />, keywords: "send invite password", admin: true },
];

const RECENT_KEY = "erp-recent";
function readRecent(): Item[] {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Item[]).slice(0, 5); } catch { return []; }
}
function remember(it: Item) {
  try {
    const next = [{ id: "r-" + it.href, kind: "recent" as const, label: it.label, hint: it.hint, href: it.href }, ...readRecent().filter((r) => r.href !== it.href)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage unavailable: recents are a convenience only */ }
}

const score = (it: Item, q: string) => {
  const hay = `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""}`.toLowerCase();
  const l = it.label.toLowerCase();
  return l.startsWith(q) ? 3 : l.includes(q) ? 2 : q.split(/\s+/).every((w) => hay.includes(w)) ? 1 : 0;
};

/** ⌘K / Ctrl+K palette: pages, actions and people. Arrow keys move, Enter opens, Esc closes. */
export function CommandPalette({ data }: { data?: Promise<ShellData | null> }) {
  const isAdmin = data ? !!React.use(data)?.isAdmin : false;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [people, setPeople] = React.useState<PersonHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [recent, setRecent] = React.useState<Item[]>([]);
  const listId = React.useId();
  const listRef = React.useRef<HTMLUListElement>(null);

  // one way in and out, so the shortcut and the button both start from a clean search
  const openChange = React.useCallback((o: boolean) => {
    setOpen(o);
    if (o) { setQ(""); setPeople([]); setActive(0); setRecent(readRecent()); }
  }, []);
  const openRef = React.useRef(open);
  React.useEffect(() => { openRef.current = open; }, [open]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openChange(!openRef.current); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openChange]);

  React.useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      setSearching(true);
      searchPeopleAction(term).then((r) => { if (r.ok) setPeople(r.data!); setSearching(false); });
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const term = q.trim().toLowerCase();
  const allowed = (i: Item) => isAdmin || !i.admin;
  const sections: { label: string; items: Item[] }[] = term
    ? [
        { label: "People", items: term.length >= 2 ? people.map((p) => ({ id: "e-" + p.id, kind: "person" as const, label: p.name, hint: [p.title, p.department].filter(Boolean).join(" · "), href: `/people/${p.id}`, person: p })) : [] },
        { label: "Actions", items: ACTIONS.filter(allowed).map((i) => [i, score(i, term)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i) },
        { label: "Pages", items: PAGES.filter(allowed).map((i) => [i, score(i, term)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i) },
      ].filter((s) => s.items.length)
    : [
        ...(recent.length ? [{ label: "Recent", items: recent }] : []),
        { label: "Actions", items: ACTIONS.filter(allowed).slice(0, 4) },
        { label: "Pages", items: PAGES.filter(allowed).slice(0, 6) },
      ];
  const flat = sections.flatMap((s) => s.items);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  const go = (it: Item) => {
    remember(it);
    openChange(false);
    router.push(it.href);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && flat[current]) { e.preventDefault(); go(flat[current]); }
  };
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  let idx = -1;
  return (
    <D.Root open={open} onOpenChange={openChange}>
      <D.Trigger asChild>
        <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-base text-text-placeholder hover:border-border-strong sm:max-w-md">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="truncate">Search people, pages, actions</span>
          <kbd className="ml-auto hidden rounded-xs border border-border bg-surface px-1.5 text-xs text-text-muted sm:inline">⌘K</kbd>
        </button>
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-60 bg-overlay/45 animate-fade-in" />
        <D.Content aria-describedby={undefined}
          className="fixed inset-x-0 top-0 z-60 flex max-h-dvh flex-col overflow-hidden bg-surface shadow-modal animate-pop-in focus:outline-none sm:inset-x-auto sm:left-1/2 sm:top-[12vh] sm:max-h-[70vh] sm:w-full sm:max-w-(--size-modal-md) sm:-translate-x-1/2 sm:rounded-lg">
          <D.Title className="sr-only">Search</D.Title>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-text-muted" aria-hidden />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); if (e.target.value.trim().length < 2) setPeople([]); }} onKeyDown={onKeyDown}
              role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-activedescendant={flat[current] ? `${listId}-${flat[current].id}` : undefined}
              placeholder="Search people, pages, actions" aria-label="Search people, pages and actions"
              className="h-13 w-full bg-transparent text-md outline-none placeholder:text-text-placeholder" />
            <kbd className="hidden rounded-xs border border-border px-1.5 text-xs text-text-muted sm:inline">Esc</kbd>
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label="Results" className="flex-1 overflow-y-auto p-2">
            {flat.length === 0 && (
              <li className="px-3 py-10 text-center text-base text-text-muted">{searching ? "Searching…" : `Nothing matches “${q.trim()}”. Try a name, an email or a page like “leave”.`}</li>
            )}
            {sections.map((s) => (
              <li key={s.label} role="presentation">
                <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-muted">{s.label}</p>
                <ul role="presentation">
                  {s.items.map((it) => {
                    idx++;
                    const i = idx;
                    return (
                      <li key={it.id} id={`${listId}-${it.id}`} role="option" aria-selected={i === current} data-index={i}
                        onMouseMove={() => setActive(i)} onClick={() => go(it)}
                        className={cn("flex cursor-default items-center gap-3 rounded-md px-3 py-2", i === current && "bg-surface-hover")}>
                        {it.person ? <Avatar name={it.person.name} size="sm" /> : (
                          <span aria-hidden className="flex size-8 items-center justify-center rounded-md bg-surface-hover text-text-muted [&_svg]:size-4">{it.kind === "recent" ? <History /> : it.icon}</span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base">{it.label}</span>
                          {it.hint && <span className="block truncate text-sm text-text-muted">{it.hint}</span>}
                        </span>
                        {i === current && <CornerDownLeft className="size-4 text-text-muted" aria-hidden />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-xs text-text-muted sm:flex">
            <span><kbd className="font-sans">↑↓</kbd> to move</span><span><kbd className="font-sans">Enter</kbd> to open</span><span><kbd className="font-sans">Esc</kbd> to close</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
