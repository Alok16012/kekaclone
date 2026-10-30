-- Expenses: what the target schema didn't record yet.
--  * how much of a linked advance each approved claim used up (so the payable amount never changes afterwards)
--  * who paid a claim / advance outside payroll, when, and the bank or UPI reference
--  * a claim is scheduled into payroll at most once (scheduleExpensePayout is idempotent)
alter table expense_claims
  add column if not exists advance_applied_paise bigint not null default 0 check (advance_applied_paise >= 0),
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references users(id) on delete set null,
  add column if not exists payment_ref text;
create index if not exists expense_claims_paid_by_idx on expense_claims (paid_by);
create index if not exists expense_claims_status_idx on expense_claims (tenant_id, status);

alter table expense_advances
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by uuid references users(id) on delete set null,
  add column if not exists payment_ref text;
create index if not exists expense_advances_paid_by_idx on expense_advances (paid_by);

create unique index if not exists payroll_inputs_expense_claim_once
  on payroll_inputs ((source_ref->>'expense_claim_id')) where kind = 'expense';

-- receipts are looked up by file id when someone opens one
create index if not exists expenses_receipts_idx on expenses using gin (receipt_file_ids);
