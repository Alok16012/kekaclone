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
  ] },
  { group: "Payroll", items: [
    { key: "payroll.admin", label: "Set up and run payroll, manage people's salaries, bank and statutory details, and record a CA check of statutory rates" },
    { key: "payroll.run", label: "Run monthly payroll and final settlements: inputs, calculation, finalising, payslips, bank files and reports (payroll admins can also roll back)" },
  ] },
  { group: "Approvals", items: [
    { key: "approvals.override", label: "Approve or decline on anyone's behalf" },
  ] },
  { group: "Lifecycle", items: [
    { key: "exits.manage", label: "Run exits: start, approve, complete and cancel them" },
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
  { group: "Settings", items: [
    { key: "settings.org", label: "Edit company structure (departments, locations, …)" },
    { key: "settings.roles", label: "Manage roles and who has them" },
    { key: "settings.security", label: "Change sign-in security (codes, login methods)" },
    { key: "settings.audit", label: "View the audit log and sign-in history" },
  ] },
  { group: "Projects & timesheets", items: [
    { key: "psa.admin", label: "Set up clients, projects, project teams and timesheet policies" },
    { key: "psa.billing", label: "Raise and manage project invoices" },
  ] },
  { group: "Learn", items: [
    { key: "learn.admin", label: "Author courses, assign them and see completion reports" },
  ] },
  { group: "Reports", items: [
    { key: "reports.read", label: "View and export reports" },
    { key: "reports.build", label: "Build, save, share and schedule custom reports" },
  ] },
] as const;

export const ALL_PERMISSION_KEYS: string[] = PERMISSIONS.flatMap((g) => g.items.map((i) => i.key));

export type ScopeType = "department" | "location" | "legal_entity" | "business_unit";
export type Scope = { type: ScopeType; ids: string[] };
export const SCOPE_LABELS: Record<ScopeType, string> = { department: "Departments", location: "Locations", legal_entity: "Legal entities", business_unit: "Business units" };
