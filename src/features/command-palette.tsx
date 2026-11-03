"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import {
  BriefcaseBusiness, CalendarDays, CalendarPlus, Clock, CornerDownLeft, FileSpreadsheet, FileText, History, Home, Inbox, LayoutDashboard,
  LayoutGrid, LifeBuoy, Mail, Receipt, Search, Settings, ShieldCheck, Target, User, UserPlus, Users, Wallet,
  ChartBar, Megaphone, PenLine, Sparkles,
} from "lucide-react";
import { DoorOpen, FilePen, UserMinus } from "lucide-react";
import { Headset, Laptop, Package, PackagePlus } from "lucide-react";
import { HandCoins, Landmark } from "lucide-react";
import { BadgeCheck, GitBranch, IdCard, ListPlus, Network } from "lucide-react";
import { ClipboardList, Link2, ListChecks, Rocket } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { cn } from "@/lib/cn";
import { planShows, type ShellData } from "@/ui/app-shell";
import type { PersonHit } from "@/server/modules/employees/service";
import { searchPeopleAction } from "@/app/(app)/actions";

type Item = { id: string; kind: "page" | "action" | "person" | "recent"; label: string; hint?: string; href: string; icon?: React.ReactNode; keywords?: string; admin?: boolean; area?: string; person?: PersonHit };

const PAGES: Item[] = [
  { id: "p-home", kind: "page", label: "Home", href: "/home", icon: <Home />, keywords: "dashboard feed start" },
  { id: "p-inbox", kind: "page", label: "Inbox", href: "/inbox", icon: <Inbox />, keywords: "approvals requests pending" },
  { id: "p-att", kind: "page", label: "Attendance", href: "/me/attendance", icon: <Clock />, keywords: "clock in out logs timesheet punch" },
  { id: "p-leave", kind: "page", label: "Leave", href: "/me/leave", icon: <CalendarDays />, keywords: "holiday time off balance chhutti" },
  { id: "p-pay", kind: "page", label: "My finances", href: "/me/pay", icon: <Wallet />, keywords: "payslip salary tax" },
  { id: "p-exp", kind: "page", label: "Expenses", href: "/me/expenses", icon: <Receipt />, keywords: "claims reimbursement" },
  { id: "p-exp-adv", kind: "page", label: "Expense advances", href: "/me/expenses/advances", icon: <Receipt />, keywords: "advance cash trip money before" },
  { id: "p-exp-desk", kind: "page", label: "Expense approvals", hint: "Expense desk", href: "/expenses/approvals", icon: <Receipt />, keywords: "claims approve finance review receipts", admin: true, area: "expenses" },
  { id: "p-exp-pay", kind: "page", label: "Expense payouts", hint: "Expense desk", href: "/expenses/payouts", icon: <Wallet />, keywords: "reimburse pay payroll off-cycle finance", admin: true, area: "expenses" },
  { id: "p-exp-rep", kind: "page", label: "Expense reports", hint: "Expense desk", href: "/expenses/reports", icon: <ChartBar />, keywords: "spend category department month csv export", admin: true, area: "expenses" },
  { id: "p-exp-set", kind: "page", label: "Expense policies", hint: "Settings", href: "/settings/expenses", icon: <Settings />, keywords: "categories limits mileage per diem receipt gl", admin: true, area: "expenses-settings" },
  { id: "p-perf", kind: "page", label: "Performance", href: "/me/performance", icon: <Target />, keywords: "goals okr review feedback" },
  { id: "p-help", kind: "page", label: "Helpdesk", href: "/me/helpdesk", icon: <LifeBuoy />, keywords: "ticket question support" },
  { id: "p-me", kind: "page", label: "My profile", href: "/me", icon: <User />, keywords: "profile details address" },
  { id: "p-people", kind: "page", label: "People", href: "/org/employees", icon: <LayoutGrid />, keywords: "directory employees staff" },
  { id: "p-team", kind: "page", label: "My team", href: "/team", icon: <Users />, keywords: "reportees" },
  { id: "p-docs", kind: "page", label: "Documents", href: "/org/documents", icon: <FileText />, keywords: "policies letters" },
  { id: "p-dash", kind: "page", label: "Dashboard", href: "/org/dashboard", icon: <LayoutDashboard />, keywords: "headcount overview hr", admin: true },
  { id: "p-hire", kind: "page", label: "Hiring", href: "/hire/jobs", icon: <BriefcaseBusiness />, keywords: "jobs candidates recruit", admin: true },
  { id: "p-set", kind: "page", label: "Settings", href: "/settings", icon: <Settings />, keywords: "configuration", admin: true, area: "settings" },
  { id: "p-org", kind: "page", label: "Company structure", hint: "Settings", href: "/settings/org/departments", icon: <Settings />, keywords: "departments designations locations bands legal entities", admin: true },
  { id: "p-roles", kind: "page", label: "Roles & permissions", hint: "Settings", href: "/settings/roles", icon: <ShieldCheck />, keywords: "access admin", admin: true },
  { id: "p-ann", kind: "page", label: "Announcements", href: "/engage/announcements", icon: <Megaphone />, keywords: "engage news pin schedule wall", admin: true },
  { id: "p-polls", kind: "page", label: "Poll results", href: "/engage/polls", icon: <ChartBar />, keywords: "engage vote survey wall", admin: true },
  { id: "p-onb", kind: "page", label: "Onboarding", href: "/org/onboarding", icon: <Rocket />, keywords: "new joiners preboarding checklist first day induction", admin: true },
  { id: "p-onb-tpl", kind: "page", label: "Onboarding tasks", hint: "Settings", href: "/settings/tasks", icon: <ListChecks />, keywords: "checklist template joiner owner due", admin: true },
  { id: "p-mytasks", kind: "page", label: "My tasks", href: "/me/tasks", icon: <ListChecks />, keywords: "onboarding to do joiner help checklist" },
  { id: "p-surveys", kind: "page", label: "Surveys", href: "/me/surveys", icon: <ClipboardList />, keywords: "pulse feedback questionnaire answer" },
  { id: "p-surveys-admin", kind: "page", label: "Survey builder and results", href: "/engage/surveys", icon: <ChartBar />, keywords: "engage enps pulse questionnaire results anonymous", admin: true },
  { id: "p-qlinks", kind: "page", label: "Quick links", hint: "Settings", href: "/settings/quick-links", icon: <Link2 />, keywords: "home shortcuts bookmarks intranet", admin: true },
  { id: "p-sec", kind: "page", label: "Sign-in security", hint: "Settings", href: "/settings/security", icon: <ShieldCheck />, keywords: "otp code 2fa mfa password", admin: true },
  { id: "p-statutory", kind: "page", label: "Statutory rates", hint: "Settings", href: "/settings/payroll/statutory", icon: <Settings />, keywords: "pf esi professional tax pt lwf gratuity income tax tds slabs ca verification", admin: true, area: "payroll" },
  { id: "p-audit", kind: "page", label: "Audit log", hint: "Settings", href: "/settings/audit", icon: <History />, keywords: "history changes who did logins sign-ins compliance", admin: true },
  { id: "p-setup", kind: "page", label: "Company setup", hint: "Getting started", href: "/setup", icon: <Settings />, keywords: "wizard onboarding first run checklist", admin: true },
  { id: "p-team-leave", kind: "page", label: "Team leave calendar", href: "/team/leave", icon: <CalendarDays />, keywords: "who is off away absent vacation" },
  { id: "p-leave-plans", kind: "page", label: "Leave plans", hint: "Settings", href: "/settings/leave/plans", icon: <Settings />, keywords: "leave policy quota accrual rules types", admin: true },
  { id: "p-leave-bal", kind: "page", label: "Leave balances", hint: "Settings", href: "/settings/leave/balances", icon: <Settings />, keywords: "adjust credit debit opening import", admin: true },
  { id: "p-leave-ye", kind: "page", label: "Leave year end", hint: "Settings", href: "/settings/leave/year-end", icon: <Settings />, keywords: "carry forward lapse encash", admin: true },
  { id: "p-holidays", kind: "page", label: "Holidays", hint: "Settings", href: "/settings/holidays", icon: <Settings />, keywords: "holiday list floater optional festival", admin: true },
  { id: "p-time", kind: "page", label: "Time settings", hint: "Shifts, weekly offs, clock-in rules", href: "/settings/time/shifts", icon: <Clock />, keywords: "shift roster weekly off geofence ip penalty late", admin: true },
  { id: "p-time-assign", kind: "page", label: "Shift and policy assignments", href: "/settings/time/assignments", icon: <Users />, keywords: "assign shift weekly off bulk", admin: true },
  { id: "p-roster", kind: "page", label: "Roster board", hint: "People × days, rotations", href: "/settings/time/roster", icon: <Clock />, keywords: "roster rota rotation shift schedule week", admin: true },
  { id: "p-overtime", kind: "page", label: "Overtime & shift allowances", href: "/settings/time/overtime", icon: <Clock />, keywords: "overtime ot pay code comp off allowance settle night", admin: true },
  { id: "p-devices", kind: "page", label: "Biometric devices", href: "/settings/time/devices", icon: <Clock />, keywords: "device biometric punch api key zkteco essl", admin: true },
  { id: "p-notifications", kind: "page", label: "Notification settings", hint: "Which events email people", href: "/settings/notifications", icon: <Users />, keywords: "notification email digest events", admin: true },
  { id: "p-exits", kind: "page", label: "Exits", href: "/org/exits", icon: <DoorOpen />, keywords: "offboarding resignation notice leaving relieving", admin: true },
  { id: "p-notice", kind: "page", label: "Notice periods & exit reasons", hint: "Settings", href: "/settings/exits", icon: <Settings />, keywords: "notice period exit reasons checklist", admin: true },
  { id: "p-payroll", kind: "page", label: "Payroll", href: "/payroll", icon: <Wallet />, keywords: "payroll run salary month finalise payslips bank file ecr register", admin: true, area: "payrun" },
  { id: "p-fnf", kind: "page", label: "Final settlements", hint: "Payroll", href: "/payroll/settlements", icon: <Wallet />, keywords: "full and final fnf f&f exit gratuity encashment", admin: true, area: "payrun" },
  { id: "p-pay-comp", kind: "page", label: "Salary components", hint: "Payroll settings", href: "/settings/payroll/components", icon: <Wallet />, keywords: "payroll basic hra allowance deduction earning", admin: true, area: "payroll" },
  { id: "p-pay-groups", kind: "page", label: "Pay groups", hint: "Payroll settings", href: "/settings/payroll/pay-groups", icon: <Wallet />, keywords: "payroll cycle cut-off payable days", admin: true, area: "payroll" },
  { id: "p-pay-struct", kind: "page", label: "Salary structures", hint: "Payroll settings", href: "/settings/payroll/structures", icon: <Wallet />, keywords: "payroll ctc breakup formula template", admin: true, area: "payroll" },
  { id: "p-pay-rev", kind: "page", label: "Salary revisions", hint: "Payroll settings", href: "/settings/payroll/revisions", icon: <FileSpreadsheet />, keywords: "increment hike appraisal ctc bulk import", admin: true, area: "payroll" },
  { id: "p-tax-me", kind: "page", label: "Income tax", hint: "My finances", href: "/me/tax", icon: <Landmark />, keywords: "tds regime declaration 80c 80d hra rent proof form 16 12bb pan investment" },
  { id: "p-loans-me", kind: "page", label: "My loans", hint: "My finances", href: "/me/loans", icon: <HandCoins />, keywords: "loan advance emi borrow salary advance" },
  { id: "p-tax-desk", kind: "page", label: "Tax desk", hint: "Payroll", href: "/payroll/tax", icon: <Landmark />, keywords: "proofs verify declarations form 16 part a traces windows cut-off", admin: true, area: "payroll" },
  { id: "p-loans-desk", kind: "page", label: "Loans desk", hint: "Payroll", href: "/payroll/loans", icon: <HandCoins />, keywords: "loan disburse emi skip prepay close", admin: true, area: "payroll" },
  { id: "p-loan-types", kind: "page", label: "Loan types", hint: "Payroll settings", href: "/settings/payroll/loans", icon: <HandCoins />, keywords: "loan categories policy interest flat reducing tenure", admin: true, area: "payroll" },
  { id: "p-assets-me", kind: "page", label: "My assets", href: "/me/assets", icon: <Laptop />, keywords: "laptop equipment issued id card acknowledge" },
  { id: "p-helpdesk-q", kind: "page", label: "Helpdesk queue", href: "/helpdesk", icon: <Headset />, keywords: "tickets agent support sla assign reply", admin: true, area: "helpdesk" },
  { id: "p-assets", kind: "page", label: "Assets", href: "/org/assets", icon: <Package />, keywords: "inventory laptop hand over return recovery", admin: true, area: "assets" },
  { id: "p-helpdesk-set", kind: "page", label: "Helpdesk categories", hint: "Settings", href: "/settings/helpdesk", icon: <Settings />, keywords: "sla escalation agents ticket", admin: true, area: "helpdesk-settings" },
  { id: "p-letters", kind: "page", label: "Letter templates", hint: "Settings", href: "/settings/documents", icon: <FilePen />, keywords: "letters relieving experience placeholders templates", admin: true },
  { id: "p-orgchart", kind: "page", label: "Org chart", href: "/org/tree", icon: <Network />, keywords: "hierarchy reporting tree structure who reports manager" },
  { id: "p-probation", kind: "page", label: "Probation", href: "/org/probation", icon: <BadgeCheck />, keywords: "confirm extend confirmation new joiners" },
  { id: "p-approvals-set", kind: "page", label: "Approval workflows", hint: "Settings", href: "/settings/approvals", icon: <GitBranch />, keywords: "approver chain levels escalation auto approve delegate hand over", admin: true },
  { id: "p-custom-fields", kind: "page", label: "Custom fields", hint: "Settings", href: "/settings/custom-fields", icon: <ListPlus />, keywords: "profile extra fields sections", admin: true },
  { id: "p-groups", kind: "page", label: "Groups & probation policies", hint: "Settings", href: "/settings/groups", icon: <Users />, keywords: "group types committees projects probation length auto confirm", admin: true },
  { id: "p-jobs", kind: "page", label: "Scheduled jobs", hint: "Settings", href: "/settings/jobs", icon: <History />, keywords: "nightly cron scheduler runs", admin: true },
  { id: "p-idcard", kind: "page", label: "My ID card", href: "/me/id-card", icon: <IdCard />, keywords: "badge qr identity card" },
  { id: "p-billing", kind: "page", label: "Billing & plan", hint: "Settings", href: "/settings/billing", icon: <Wallet />, keywords: "subscription invoices upgrade seats trial razorpay gst", admin: true },
  { id: "p-branding", kind: "page", label: "Branding", hint: "Settings", href: "/settings/branding", icon: <Settings />, keywords: "logo accent colour theme login page", admin: true },
  { id: "p-integrations", kind: "page", label: "Integrations", hint: "Settings", href: "/settings/integrations", icon: <Settings />, keywords: "slack teams calendar google outlook tally zoho accounting export", admin: true },
  { id: "p-api", kind: "page", label: "API & webhooks", hint: "Settings", href: "/settings/api", icon: <Settings />, keywords: "api keys tokens webhooks developers rest", admin: true },
];
const ACTIONS: Item[] = [
  { id: "a-leave", kind: "action", label: "Apply for leave", href: "/me/leave?apply=1", icon: <CalendarPlus />, keywords: "request time off chhutti" },
  { id: "a-expense", kind: "action", label: "Add an expense", href: "/me/expenses?add=1", icon: <Receipt />, keywords: "claim receipt reimbursement bill" },
  { id: "a-clock", kind: "action", label: "Clock in or out", href: "/me/attendance", icon: <Clock />, keywords: "punch attendance" },
  { id: "a-compoff", kind: "action", label: "Claim comp-off", href: "/me/leave?compoff=1", icon: <CalendarPlus />, keywords: "worked weekend holiday compensatory off" },
  { id: "a-post", kind: "action", label: "Write a post", href: "/home?compose=post", icon: <PenLine />, keywords: "wall share update engage" },
  { id: "a-praise", kind: "action", label: "Praise a colleague", href: "/home?compose=praise", icon: <Sparkles />, keywords: "kudos thanks badge appreciate" },
  { id: "a-onboard", kind: "action", label: "Start onboarding", hint: "Onboarding", href: "/org/onboarding", icon: <Rocket />, keywords: "new joiner initiate checklist", admin: true },
  { id: "a-survey", kind: "action", label: "Create a survey", hint: "Surveys", href: "/engage/surveys", icon: <ClipboardList />, keywords: "pulse enps questionnaire feedback", admin: true },
  { id: "a-add", kind: "action", label: "Add an employee", href: "/org/employees/new", icon: <UserPlus />, keywords: "new hire joiner", admin: true },
  { id: "a-import", kind: "action", label: "Import people from Excel", href: "/org/employees/import", icon: <FileSpreadsheet />, keywords: "bulk upload xlsx", admin: true },
  { id: "a-bulk-update", kind: "action", label: "Update people from Excel", href: "/org/employees/update", icon: <FilePen />, keywords: "bulk edit change designation department manager xlsx", admin: true },
  { id: "a-handover", kind: "action", label: "Hand over my approvals", hint: "While you're away", href: "/inbox", icon: <Inbox />, keywords: "delegate out of office vacation approver" },
  { id: "a-invite", kind: "action", label: "Invite people", hint: "Select them in People", href: "/org/employees", icon: <Mail />, keywords: "send invite password", admin: true },
  { id: "a-regularize", kind: "action", label: "Regularize attendance", hint: "From a day's menu", href: "/me/attendance", icon: <Clock />, keywords: "forgot clock out fix punch missing swipe" },
  { id: "a-wfh", kind: "action", label: "Ask to work from home", href: "/me/attendance?tab=requests", icon: <Home />, keywords: "wfh remote on duty od" },
  { id: "a-declare", kind: "action", label: "Declare investments for tax", href: "/me/tax?tab=deductions", icon: <Landmark />, keywords: "80c ppf elss insurance tax saving declaration" },
  { id: "a-loan", kind: "action", label: "Ask for a loan", href: "/me/loans", icon: <HandCoins />, keywords: "salary advance borrow emi" },
  { id: "a-ticket", kind: "action", label: "Raise a helpdesk ticket", href: "/me/helpdesk?new=1", icon: <LifeBuoy />, keywords: "help support it hr question problem issue" },
  { id: "a-asset-req", kind: "action", label: "Request an asset", href: "/me/assets?request=1", icon: <PackagePlus />, keywords: "laptop monitor headset equipment need" },
  { id: "a-resign", kind: "action", label: "Resign", hint: "From your profile", href: "/me", icon: <UserMinus />, keywords: "resignation quit leave job notice" },
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
  const shell = data ? React.use(data) : null;
  const isAdmin = !!shell?.isAdmin;
  const areas = shell?.areas ?? [];
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
  const allowed = (i: Item) => planShows(shell, i.href) && (isAdmin || !i.admin || (!!i.area && areas.includes(i.area)));
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
