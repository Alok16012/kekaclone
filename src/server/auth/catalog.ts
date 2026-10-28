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
  { group: "Approvals", items: [
    { key: "approvals.override", label: "Approve or decline on anyone's behalf" },
  ] },
  { group: "Settings", items: [
    { key: "settings.org", label: "Edit company structure (departments, locations, …)" },
    { key: "settings.roles", label: "Manage roles and who has them" },
  ] },
  { group: "Reports", items: [
    { key: "reports.read", label: "View and export reports" },
  ] },
] as const;

export const ALL_PERMISSION_KEYS: string[] = PERMISSIONS.flatMap((g) => g.items.map((i) => i.key));

export type ScopeType = "department" | "location" | "legal_entity" | "business_unit";
export type Scope = { type: ScopeType; ids: string[] };
export const SCOPE_LABELS: Record<ScopeType, string> = { department: "Departments", location: "Locations", legal_entity: "Legal entities", business_unit: "Business units" };
