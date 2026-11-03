"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell, BriefcaseBusiness, LayoutDashboard, CalendarDays, ChevronsLeft, Clock, FileText, Home, Inbox, LayoutGrid, LifeBuoy,
  Menu as MenuIcon, Receipt, Search, Settings, Target, User, Users, Wallet, X,
  Megaphone, ReceiptIndianRupee,
} from "lucide-react";
import { DoorOpen } from "lucide-react";
import { HandCoins, Headset, Landmark, Laptop, Package } from "lucide-react";
import { Network } from "lucide-react";
import { ClipboardList, ListChecks, Rocket } from "lucide-react";
import { Gauge, IndianRupee } from "lucide-react";
import { ChartColumn, FolderKanban, GraduationCap, Timer } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "./avatar";
import { IconButton } from "./button";
import { Menu } from "./overlay";
import { ThemeToggle } from "./theme";

export type ShellData = {
  tenant: string; user: { name: string; title: string }; isAdmin: boolean; areas?: string[]; inboxCount: number; unread: number;
  /** plan features the workspace has (see saas/plans.ts); when absent nothing is hidden */
  features?: string[];
};

export type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number };
export type NavGroup = { label?: string; items: NavItem[] };

export const DEFAULT_NAV: NavGroup[] = [
  { items: [
    { href: "/home", label: "Home", icon: Home },
    { href: "/inbox", label: "Inbox", icon: Inbox },
  ] },
  { label: "Me", items: [
    { href: "/me/attendance", label: "Attendance", icon: Clock },
    { href: "/me/leave", label: "Leave", icon: CalendarDays },
    { href: "/me/pay", label: "My finances", icon: Wallet },
    { href: "/me/tax", label: "Income tax", icon: Landmark },
    { href: "/me/loans", label: "Loans", icon: HandCoins },
    { href: "/me/expenses", label: "Expenses", icon: Receipt },
    { href: "/me/performance", label: "Performance", icon: Target },
    { href: "/me/helpdesk", label: "Helpdesk", icon: LifeBuoy },
    { href: "/me/assets", label: "My assets", icon: Laptop },
    { href: "/me/tasks", label: "My tasks", icon: ListChecks },
    { href: "/me/surveys", label: "Surveys", icon: ClipboardList },
    { href: "/me/jobs", label: "Jobs & referrals", icon: BriefcaseBusiness },
    { href: "/me/timesheet", label: "Timesheet", icon: Timer },
    { href: "/me/learn", label: "Learning", icon: GraduationCap },
  ] },
  { label: "Organisation", items: [
    { href: "/org/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/team", label: "My team", icon: Users },
    { href: "/org/employees", label: "People", icon: LayoutGrid },
    { href: "/org/tree", label: "Org chart", icon: Network },
    { href: "/org/documents", label: "Documents", icon: FileText },
    { href: "/org/onboarding", label: "Onboarding", icon: Rocket },
    { href: "/org/exits", label: "Exits", icon: DoorOpen },
    { href: "/payroll", label: "Payroll", icon: Landmark },
    { href: "/expenses/approvals", label: "Expense desk", icon: ReceiptIndianRupee },
    { href: "/payroll/tax", label: "Tax desk", icon: Landmark },
    { href: "/payroll/loans", label: "Loans desk", icon: HandCoins },
    { href: "/org/assets", label: "Assets", icon: Package },
    { href: "/helpdesk", label: "Helpdesk queue", icon: Headset },
    { href: "/performance", label: "Review cycles", icon: Gauge },
    { href: "/compensation", label: "Compensation", icon: IndianRupee },
    { href: "/psa/projects", label: "Projects", icon: FolderKanban },
    { href: "/learn/admin", label: "Learn admin", icon: GraduationCap },
    { href: "/reports", label: "Reports", icon: ChartColumn },
    { href: "/hire/jobs", label: "Hiring", icon: BriefcaseBusiness },
    { href: "/engage/announcements", label: "Announcements", icon: Megaphone },
    { href: "/settings", label: "Settings", icon: Settings },
  ] },
];

const MOBILE_NAV: NavItem[] = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/me/attendance", label: "Attendance", icon: Clock },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/me/leave", label: "Leave", icon: CalendarDays },
  { href: "/me", label: "Me", icon: User },
];

function NavLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed?: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  const active = path === item.href || path.startsWith(item.href + "/");
  const Icon = item.icon;
  return (
    <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}
      className={cn("group flex h-9 items-center gap-3 rounded-md px-3 text-base font-medium text-text-muted transition-colors duration-fast hover:bg-surface-hover hover:text-text",
        active && "bg-sidebar-active text-sidebar-active-text hover:bg-sidebar-active hover:text-sidebar-active-text", collapsed && "justify-center px-0")}>
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && item.badge ? <span className="rounded-pill bg-accent px-1.5 text-xs font-semibold tabular text-on-accent">{item.badge}</span> : null}
      {collapsed && item.badge ? <span className="sr-only">, {item.badge} pending</span> : null}
    </Link>
  );
}

function SidebarContent({ nav, collapsed, onNavigate, tenant }: { nav: NavGroup[]; collapsed?: boolean; onNavigate?: () => void; tenant: string }) {
  return (
    <>
      <div className={cn("flex h-(--size-topbar) shrink-0 items-center gap-2.5 border-b border-border px-4", collapsed && "justify-center px-0")}>
        <span aria-hidden className="flex size-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-on-accent">e</span>
        {!collapsed && <span className="truncate text-md font-semibold">{tenant}</span>}
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3">
        {nav.map((g, i) => (
          <div key={i} className={cn(i > 0 && "mt-5")}>
            {g.label && !collapsed && <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-text-muted">{g.label}</p>}
            {g.label && collapsed && <div className="mx-3 mb-2 h-px bg-border" />}
            <ul className="flex flex-col gap-0.5">{g.items.map((it) => <li key={it.href}><NavLink item={it} collapsed={collapsed} onNavigate={onNavigate} /></li>)}</ul>
          </div>
        ))}
      </nav>
    </>
  );
}

/**
 * Layout: sidebar (lg+, collapsible to icons), top bar with search / notifications / profile,
 * off-canvas sidebar on md, bottom tab bar below md. A skip link jumps to main content.
 */
const ADMIN_ONLY = new Set(["/settings", "/hire/jobs", "/org/dashboard", "/org/onboarding", "/org/exits", "/engage/announcements", "/expenses/approvals", "/org/assets", "/helpdesk", "/payroll", "/payroll/tax", "/payroll/loans", "/performance", "/compensation", "/psa/projects", "/learn/admin", "/reports"]);
/** Admin-only entries that a narrower role also opens (ShellData.areas, worked out in the app layout). */
const AREA: Record<string, string> = { "/payroll": "payrun", "/settings": "settings", "/expenses/approvals": "expenses", "/org/assets": "assets", "/helpdesk": "helpdesk", "/payroll/tax": "payroll", "/payroll/loans": "payroll", "/hire/jobs": "hire", "/psa/projects": "psa", "/learn/admin": "learn", "/reports": "reports", "/performance": "performance", "/compensation": "compensation", "/org/onboarding": "onboarding" };
/** Entries that only make sense on a plan that has the feature (hidden when ShellData.features says the plan lacks it). */
export const FEATURE_OF: Record<string, string> = { "/hire/jobs": "hire", "/me/performance": "performance" };
export const planShows = (d: ShellData | null, href: string) => !FEATURE_OF[href] || !d?.features || d.features.includes(FEATURE_OF[href]);
const showItem = (d: ShellData | null, href: string) => planShows(d, href) && (!ADMIN_ONLY.has(href) || !!d?.isAdmin || (!!AREA[href] && !!d?.areas?.includes(AREA[href])));

function navFor(d: ShellData | null): NavGroup[] {
  return DEFAULT_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => showItem(d, i.href)).map((i) => (i.href === "/inbox" ? { ...i, badge: d?.inboxCount || undefined } : i)),
  }));
}

/** Reads the shell data promise; only ever rendered inside a Suspense boundary. */
function useShell(data: Promise<ShellData | null> | ShellData | null | undefined) {
  return data instanceof Promise ? React.use(data) : (data ?? null);
}

/**
 * Layout: sidebar (lg+, collapsible to icons), top bar with search / notifications / profile,
 * off-canvas sidebar on md, bottom tab bar below md. A skip link jumps to main content.
 * `data` may be a promise: everything user-specific streams in behind small Suspense boundaries,
 * while the page content renders straight away.
 */
export function AppShell({ children, data, logout, bell, search }: {
  children: React.ReactNode; data?: Promise<ShellData | null> | ShellData | null; logout?: () => Promise<{ redirectTo: string }>;
  /** notifications control and search supplied by the app (the design system doesn't know about server actions) */
  bell?: React.ReactNode;
  search?: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  return (
    <div className="min-h-dvh bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-80 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>

      <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-sidebar transition-[width] duration-base lg:flex",
        collapsed ? "w-(--size-sidebar-collapsed)" : "w-(--size-sidebar)")}>
        <React.Suspense fallback={<SidebarContent nav={navFor(null)} collapsed={collapsed} tenant="" />}><ShellSidebar data={data} collapsed={collapsed} /></React.Suspense>
        <div className="border-t border-border p-3">
          <button type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn("flex h-9 w-full items-center gap-3 rounded-md px-3 text-base text-text-muted hover:bg-surface-hover hover:text-text", collapsed && "justify-center px-0")}>
            <ChevronsLeft className={cn("size-[18px] transition-transform duration-base", collapsed && "rotate-180")} />
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal aria-label="Navigation">
          <div className="absolute inset-0 bg-overlay/45 animate-fade-in" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-(--size-sidebar) flex-col bg-sidebar shadow-modal animate-pop-in">
            <React.Suspense fallback={<SidebarContent nav={navFor(null)} tenant="" />}><ShellSidebar data={data} onNavigate={() => setMobileOpen(false)} /></React.Suspense>
            <IconButton label="Close navigation" className="absolute right-2 top-3" onClick={() => setMobileOpen(false)}><X /></IconButton>
          </aside>
        </div>
      )}

      <div className={cn("transition-[padding] duration-base", collapsed ? "lg:pl-(--size-sidebar-collapsed)" : "lg:pl-(--size-sidebar)")}>
        <header className="sticky top-0 z-20 flex h-(--size-topbar) items-center gap-2 border-b border-border bg-surface/85 px-4 backdrop-blur-md sm:px-6">
          <IconButton label="Open navigation" className="hidden md:inline-flex lg:hidden" onClick={() => setMobileOpen(true)}><MenuIcon /></IconButton>
          {search ? <React.Suspense fallback={<SearchPlaceholder />}>{search}</React.Suspense> : <SearchPlaceholder />}
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <React.Suspense fallback={<IconButton label="Notifications"><Bell /></IconButton>}>{bell ?? <NotificationsButton data={data} />}</React.Suspense>
            <React.Suspense fallback={<span className="ml-1 size-8 rounded-pill bg-surface-hover" aria-hidden />}><AccountMenu data={data} logout={logout} /></React.Suspense>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-(--size-content-max) px-4 pb-24 pt-6 focus:outline-none sm:px-6 md:pb-10">{children}</main>
      </div>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex h-(--size-bottom-nav) border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        <React.Suspense fallback={MOBILE_NAV.map((it) => <BottomLink key={it.href} item={it} />)}><BottomLinks data={data} /></React.Suspense>
      </nav>
    </div>
  );
}

function BottomLink({ item }: { item: NavItem }) {
  const path = usePathname();
  const active = path === item.href || path.startsWith(item.href + "/");
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined}
      className={cn("relative flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium", active ? "text-accent-text" : "text-text-muted")}>
      <Icon className="size-5" />
      {item.label}
      {item.badge ? <span className="absolute left-1/2 top-2 ml-1.5 rounded-pill bg-danger px-1 text-[10px] font-semibold tabular text-on-accent" aria-label={`${item.badge} pending`}>{item.badge}</span> : null}
    </Link>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-text-muted">{breadcrumb}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
        {description && <p className="mt-1 text-base text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Shown while the session is read: same frame as the real shell, so nothing jumps when it arrives. */
export function ShellSkeleton() {
  return (
    <div className="min-h-dvh bg-canvas" aria-busy aria-label="Loading">
      <aside className="fixed inset-y-0 left-0 hidden w-(--size-sidebar) border-r border-border bg-sidebar lg:block">
        <div className="flex h-(--size-topbar) items-center gap-2.5 border-b border-border px-4"><div className="size-8 rounded-md bg-surface-hover" /><div className="h-4 w-28 rounded-sm bg-surface-hover" /></div>
        <div className="flex flex-col gap-2 p-3">{Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-9 rounded-md bg-surface-hover/60" />)}</div>
      </aside>
      <div className="lg:pl-(--size-sidebar)">
        <div className="h-(--size-topbar) border-b border-border bg-surface" />
        <div className="mx-auto max-w-(--size-content-max) px-4 pt-6 sm:px-6"><div className="h-8 w-56 rounded-sm bg-surface-hover" /><div className="mt-6 grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 rounded-lg bg-surface-hover/60" />)}</div></div>
      </div>
    </div>
  );
}

function ShellSidebar({ data, collapsed, onNavigate }: { data: Promise<ShellData | null> | ShellData | null | undefined; collapsed?: boolean; onNavigate?: () => void }) {
  const d = useShell(data);
  return <SidebarContent nav={navFor(d)} collapsed={collapsed} tenant={d?.tenant ?? ""} onNavigate={onNavigate} />;
}

function NotificationsButton({ data }: { data: Promise<ShellData | null> | ShellData | null | undefined }) {
  const unread = useShell(data)?.unread ?? 0;
  return (
    <IconButton label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative">
      <Bell />{unread > 0 && <span aria-hidden className="absolute right-2 top-2 size-2 rounded-pill bg-danger ring-2 ring-surface" />}
    </IconButton>
  );
}

function AccountMenu({ data, logout }: { data: Promise<ShellData | null> | ShellData | null | undefined; logout?: () => Promise<{ redirectTo: string }> }) {
  const user = useShell(data)?.user ?? { name: "", title: "" };
  const router = useRouter();
  return (
    <Menu trigger={
      <button type="button" aria-label={`Account menu for ${user.name}`} className="ml-1 flex items-center gap-2 rounded-pill p-0.5 pr-2 hover:bg-surface-hover">
        <Avatar name={user.name || "?"} size="sm" />
        <span className="hidden text-left leading-tight md:block"><span className="block text-sm font-medium">{user.name}</span><span className="block text-xs text-text-muted">{user.title}</span></span>
      </button>
    } items={[
      { label: "My profile", icon: <User />, onSelect: () => router.push("/me") },
      { label: "Settings", icon: <Settings />, onSelect: () => router.push("/settings") },
      "separator",
      { label: "Sign out", danger: true, onSelect: () => { void logout?.().then((r) => window.location.assign(r.redirectTo)); } },
    ]} />
  );
}

function BottomLinks({ data }: { data: Promise<ShellData | null> | ShellData | null | undefined }) {
  const inboxCount = useShell(data)?.inboxCount ?? 0;
  return <>{MOBILE_NAV.map((it) => <BottomLink key={it.href} item={it.href === "/inbox" ? { ...it, badge: inboxCount || undefined } : it} />)}</>;
}

function SearchPlaceholder() {
  return (
    <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-base text-text-placeholder hover:border-border-strong sm:max-w-md">
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="truncate">Search people, pages, actions</span>
      <kbd className="ml-auto hidden rounded-xs border border-border bg-surface px-1.5 text-xs text-text-muted sm:inline">⌘K</kbd>
    </button>
  );
}
