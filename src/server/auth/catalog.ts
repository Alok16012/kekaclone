/** Every permission erp knows about, grouped for the role editor. Pure: shared by server checks and the settings UI. */
export const PERMISSIONS = [
  { group: "People", items: [
    { key: "employees.read", label: "View everyone's full profile" },
    { key: "employees.write", label: "Add people and edit profiles and job details" },
  ] },
  { group: "Time", items: [
    { key: "leave.admin", label: "Manage leave plans, balances and requests" },
    { key: "attendance.admin", label: "Manage shifts, attendance and regularisations" },
  ] },
  { group: "Engage", items: [
    { key: "engage.announce", label: "Post announcements and moderate the Home wall" },
    { key: "surveys.manage", label: "Create surveys and see their results" },
  ] },
  { group: "Payroll", items: [
    { key: "payroll.admin", label: "Set up and run payroll, manage people's salaries, bank and statutory details, and record a CA check of statutory rates" },
    { key: "payroll.run", label: "Run monthly payroll and final settlements: inputs, calculation, finalising, payslips, bank files and reports (payroll admins can also roll back)" },
  ] },
  { group: "Performance", items: [
    { key: "performance.admin", label: "Run review cycles, calibrate and publish ratings, set goal and rating settings, manage the skills library and see everyone's goals" },
    { key: "compensation.admin", label: "Plan compensation cycles: budgets, increment matrix, recommendations for anyone, and applying raises to payroll" },
  ] },
  { group: "Approvals", items: [
    { key: "approvals.override", label: "Approve or decline on anyone's behalf" },
    { key: "settings.approvals", label: "Set up approval workflows, auto-approval, escalation and delegations" },
  ] },
  { group: "Lifecycle", items: [
    { key: "exits.manage", label: "Run exits: start, approve, complete and cancel them" },
    { key: "onboarding.manage", label: "Run onboarding for new joiners and edit onboarding task templates" },
  ] },
  { group: "Documents", items: [
    { key: "documents.manage", label: "Manage company documents, letter templates and issue letters" },
  ] },
  { group: "Expenses", items: [
    { key: "expenses.admin", label: "Set up expense policies and categories" },
    { key: "expenses.approve", label: "Review expense claims and advances as finance" },
    { key: "expenses.payout", label: "Pay out expense claims and advances, or schedule them into payroll" },
  ] },
  { group: "Service desk", items: [
    { key: "helpdesk.admin", label: "Set up helpdesk categories and handle every ticket" },
    { key: "assets.admin", label: "Manage the asset inventory, hand assets out and take them back" },
  ] },
  { group: "Hiring", items: [
    { key: "hire.admin", label: "Set up hiring (flows, scorecards, templates, careers page) and see every job, candidate and offer" },
    { key: "hire.recruit", label: "Recruit: post jobs, add candidates, schedule interviews and draft offers for the jobs you're on" },
  ] },
  { group: "Settings", items: [
    { key: "settings.org", label: "Edit company structure (departments, locations, …)" },
    { key: "settings.roles", label: "Manage roles and who has them" },
    { key: "settings.security", label: "Change sign-in security (codes, login methods)" },
    { key: "settings.audit", label: "View the audit log and sign-in history" },
    { key: "settings.billing", label: "See the plan and invoices, change or cancel the subscription" },
    { key: "settings.integrations", label: "Manage API keys, webhooks and Slack / Teams / calendar integrations" },
    { key: "settings.notifications", label: "Choose which events send in-app notifications and emails" },
  ] },
  { group: "Reports", items: [
    { key: "reports.read", label: "View and export reports" },
  ] },
] as const;

export const ALL_PERMISSION_KEYS: string[] = PERMISSIONS.flatMap((g) => g.items.map((i) => i.key));

export type ScopeType = "department" | "location" | "legal_entity" | "business_unit";
export type Scope = { type: ScopeType; ids: string[] };
export const SCOPE_LABELS: Record<ScopeType, string> = { department: "Departments", location: "Locations", legal_entity: "Legal entities", business_unit: "Business units" };
