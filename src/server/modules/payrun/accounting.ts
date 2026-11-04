/**
 * Accounting exports (pure, no I/O): the month's payroll journal as a Tally import (XML voucher) and as a Zoho Books
 * journal CSV. Both are data files for your accountant to import and check; ledger names come from each component's
 * GL code (Settings → Payroll → Salary components) with a readable fallback, so map them to your chart of accounts.
 * Debits always equal credits (see journalLines()). Amounts are rupees with two decimals.
 */
import { csv, rupees, shortMonth, type ISODate, type PayItem } from "./rules";

export type JournalLine = { account: string; glCode: string | null; side: "debit" | "credit"; paise: number };
export type Ledger = { account: string; glCode: string | null; debitPaise: number; creditPaise: number };

/** A component's ledger name: "GL code · name" when a GL code is set, else the name alone. */
export const ledgerName = (name: string, glCode: string | null | undefined) => (glCode ? `${glCode} · ${name}` : name);
const strip = (label: string) => label.replace(/ \(.*\)$/, "").replace(/^(Arrears|Loss of pay[^:]*): /, "");

/**
 * Journal lines for a set of payroll lines: salary cost by component (debit), employer contributions (debit) against
 * what is owed (credit): net salaries, each statutory payable, each recovery. Employer contributions are credited to
 * their payable account. Debits equal credits because every earning is either paid out (net) or withheld (deductions).
 */
export function journalLines(lines: { earnings: PayItem[]; deductions: PayItem[]; employer: PayItem[]; netPaise: number }[], gl: Record<string, string | null> = {}): JournalLine[] {
  const acc = new Map<string, JournalLine>();
  const add = (side: JournalLine["side"], account: string, glCode: string | null, paise: number) => {
    if (!paise) return;
    const k = `${side}|${account}`;
    const cur = acc.get(k) ?? { account, glCode, side, paise: 0 };
    cur.paise += paise; acc.set(k, cur);
  };
  const code = (c: string) => c.replace(/^(ARR|LOP)_/, "");
  for (const l of lines) {
    for (const e of l.earnings ?? []) add("debit", e.kind === "reimbursement" ? ledgerName(`Reimbursements: ${strip(e.label)}`, gl[code(e.code)]) : ledgerName(`Salary: ${strip(e.label)}`, gl[code(e.code)]), gl[code(e.code)] ?? null, e.paise);
    for (const x of l.employer ?? []) {
      add("debit", ledgerName(`Employer contribution: ${x.label}`, gl[x.code]), gl[x.code] ?? null, x.paise);
      add("credit", `Payable: ${x.label.replace(/ \(employer share\)/, "")}`, null, x.paise);
    }
    for (const d of l.deductions ?? []) add("credit", d.kind === "statutory" ? `Payable: ${d.label}` : ledgerName(`Recovered: ${strip(d.label)}`, gl[d.code]), d.kind === "statutory" ? null : gl[d.code] ?? null, d.paise);
    add("credit", "Net salaries payable", null, l.netPaise);
  }
  return [...acc.values()].sort((a, b) => (a.side === b.side ? a.account.localeCompare(b.account) : a.side === "debit" ? -1 : 1));
}

/** Debit / credit totals of a journal (they match when the lines came from journalLines). */
export function journalTotals(lines: JournalLine[]) {
  return { debitPaise: lines.filter((l) => l.side === "debit").reduce((t, l) => t + l.paise, 0), creditPaise: lines.filter((l) => l.side === "credit").reduce((t, l) => t + l.paise, 0) };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tallyDate = (d: ISODate) => d.replace(/-/g, "");

/**
 * Tally journal voucher (XML import). Each ledger is one ALLLEDGERENTRIES.LIST; Tally's convention is that debits are
 * "deemed positive" with a negative AMOUNT and credits the other way round. Ledgers must exist in Tally with the same
 * names (or be mapped on import).
 */
export function tallyJournalXml(lines: JournalLine[], a: { company: string; month: ISODate; voucherDate: ISODate; narration?: string }) {
  const narration = a.narration ?? `Salary for ${shortMonth(a.month)}`;
  const entries = lines.map((l) => [
    "        <ALLLEDGERENTRIES.LIST>",
    `          <LEDGERNAME>${xml(l.account)}</LEDGERNAME>`,
    `          <ISDEEMEDPOSITIVE>${l.side === "debit" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `          <AMOUNT>${l.side === "debit" ? "-" : ""}${rupees(l.paise)}</AMOUNT>`,
    "        </ALLLEDGERENTRIES.LIST>",
  ].join("\n")).join("\n");
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "  <BODY><IMPORTDATA>",
    `    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(a.company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`,
    "    <REQUESTDATA><TALLYMESSAGE xmlns:UDF=\"TallyUDF\">",
    '      <VOUCHER VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">',
    `        <DATE>${tallyDate(a.voucherDate)}</DATE>`,
    `        <EFFECTIVEDATE>${tallyDate(a.voucherDate)}</EFFECTIVEDATE>`,
    "        <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>",
    `        <NARRATION>${xml(narration)} (exported from erp)</NARRATION>`,
    "        <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>",
    entries,
    "      </VOUCHER>",
    "    </TALLYMESSAGE></REQUESTDATA>",
    "  </IMPORTDATA></BODY>",
    "</ENVELOPE>",
  ].join("\n") + "\n";
  return { text, name: `tally-payroll-${a.month.slice(0, 7)}.xml` };
}

/**
 * Zoho Books manual journal import (CSV): one row per ledger line, all sharing the journal date, reference and notes.
 * Column names follow Zoho's journal import template; map any that differ during the import.
 */
export function zohoJournalCsv(lines: JournalLine[], a: { month: ISODate; voucherDate: ISODate; reference: string; notes?: string }) {
  const notes = a.notes ?? `Salary for ${shortMonth(a.month)} (exported from erp)`;
  const rows = lines.map((l) => [a.voucherDate, a.reference, notes, "INR", l.account, l.glCode ?? "", l.side === "debit" ? rupees(l.paise) : "", l.side === "credit" ? rupees(l.paise) : "", l.account]);
  return { text: csv([["Journal Date", "Reference Number", "Notes", "Currency", "Account", "Account Code", "Debit", "Credit", "Description"], ...rows]), name: `zoho-journal-${a.month.slice(0, 7)}.csv` };
}
