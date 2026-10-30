/** Plain-English labels shared by the leave screens (server and client). */
export const KIND_LABEL: Record<string, string> = { regular: "Regular", incident: "Event based", comp_off: "Comp-off", unpaid: "Unpaid" };
export const KIND_HINT: Record<string, string> = {
  regular: "Has a yearly quota that people accrue, like casual or earned leave.",
  incident: "Granted for an event, like marriage or bereavement, usually credited up front.",
  comp_off: "Earned by working on a weekly off or holiday, then used like leave.",
  unpaid: "Leave without pay. Usually unlimited, and deducted in payroll.",
};
export const YEAR_START_LABEL: Record<string, string> = { jan: "January to December", apr: "April to March", joining_date: "From each person's joining date" };
export const FREQ_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", half_yearly: "Half-yearly", yearly: "Yearly", upfront: "All at once, at the start of the year" };
export const APPROVER_LABEL: Record<string, string> = { manager: "Reporting manager", l2_manager: "Manager's manager", hr_admin: "HR admin", global_admin: "Global admin" };
export const LEDGER_LABEL: Record<string, string> = {
  opening: "Opening balance", accrual: "Accrual", use: "Leave taken", use_reversal: "Leave cancelled", adjust: "Adjustment", encash: "Encashed",
  carry_forward: "Carry forward", lapse: "Lapsed", penalty: "Penalty", comp_off_credit: "Comp-off earned", expiry: "Comp-off expired",
};
/** Leave type colours: the chart palette (adapts to dark mode). */
export const COLOURS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--chart-${n})`);

export const fmtDays = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")} ${Math.abs(n) === 1 ? "day" : "days"}`;
export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
export const fmtDate = (d: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });
export const fmtMonth = (ym: string) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
