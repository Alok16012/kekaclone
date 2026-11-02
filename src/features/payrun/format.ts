/** Display helpers for payroll screens (client-safe). */
export { money, fmtDate, fmtMonth } from "@/features/payroll/labels";

export const RUN_TONE: Record<string, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  draft: "neutral", in_progress: "accent", finalized: "warning", payslips_released: "warning", paid: "success", rolled_back: "danger",
};
export const RUN_LABEL: Record<string, string> = {
  draft: "Not calculated", in_progress: "In progress", finalized: "Finalised", payslips_released: "Payslips released", paid: "Paid", rolled_back: "Rolled back",
};
export const INPUT_LABEL: Record<string, string> = {
  lop_adjust: "Loss of pay added", lop_reversal: "Loss of pay reversed", bonus: "Bonus", adhoc_earning: "One-time payment", adhoc_deduction: "One-time deduction",
  arrear: "Arrears", overtime: "Overtime", shift_allowance: "Shift allowance", component_claim: "Reimbursement claim", expense: "Expense claim", loan_emi: "Loan repayment",
  leave_encashment: "Leave encashment", statutory_override: "Statutory override", pay_action: "Pay action", processing_hold: "Hold processing", payout_hold: "Hold payout",
};
export const ACTION_LABEL: Record<string, string> = {
  process: "Process", hold_processing: "Hold processing", hold_payout: "Hold payout", void: "Don't pay", paid_outside: "Paid outside erp",
};
export const OVERRIDE_LABEL: Record<string, string> = { PF_EMPLOYEE: "Provident fund", ESI: "ESI", PT: "Professional tax", LWF: "Labour welfare fund", TDS: "Income tax (TDS)" };
