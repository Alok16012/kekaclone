-- Tax declarations + loans: what the target schema didn't record yet. The main tables (tax_declarations,
-- tax_declaration_items, form16_documents, loan_categories, loans, loan_installments, payroll_inputs) exist since 0001.

-- who checked a proof and when; when the person sent the declaration
alter table tax_declaration_items
  add column if not exists reviewed_by uuid references users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add constraint tax_declaration_items_accepted_check check (accepted_paise is null or (accepted_paise >= 0 and accepted_paise <= declared_paise));
create index if not exists tax_declaration_items_reviewed_by_idx on tax_declaration_items (reviewed_by);
create unique index if not exists tax_declaration_items_once on tax_declaration_items (declaration_id, section, item);
create index if not exists tax_declaration_items_proofs_idx on tax_declaration_items using gin (proof_file_ids);
create index if not exists tax_declaration_items_queue_idx on tax_declaration_items (tenant_id, proof_status);
alter table tax_declarations add column if not exists submitted_at timestamptz;
create index if not exists tax_declarations_fy_idx on tax_declarations (tenant_id, fy_start);

alter table form16_documents add column if not exists published_by uuid references users(id) on delete set null;
create index if not exists form16_documents_published_by_idx on form16_documents (published_by);

-- loans: a withdrawn or cancelled request, the broken-period (pre-EMI) interest charged with the first EMI,
-- who disbursed it and the bank reference, when it closed
alter table loans drop constraint if exists loans_status_check;
alter table loans add constraint loans_status_check
  check (status in ('requested','approved','rejected','cancelled','disbursed','active','closed','written_off'));
alter table loans
  add column if not exists pre_emi_interest_paise bigint not null default 0 check (pre_emi_interest_paise >= 0),
  add column if not exists disbursed_by uuid references users(id) on delete set null,
  add column if not exists disbursal_ref text,
  add column if not exists closed_on date,
  add constraint loans_interest_rate_check check (interest_rate >= 0),
  add constraint loans_emi_check check (emi_paise is null or emi_paise > 0),
  add constraint loans_first_emi_month_check check (first_emi_month is null or extract(day from first_emi_month) = 1);
create index if not exists loans_disbursed_by_idx on loans (disbursed_by);
create index if not exists loans_status_idx on loans (tenant_id, status);
alter table loan_categories
  add constraint loan_categories_rate_check check (interest_rate >= 0 and (rate_type <> 'zero' or interest_rate = 0)),
  add constraint loan_categories_max_check check ((max_amount_paise is null or max_amount_paise > 0) and (max_tenure_months is null or max_tenure_months between 1 and 360));
alter table loan_installments
  add constraint loan_installments_amounts_check check (principal_paise >= 0 and interest_paise >= 0),
  add constraint loan_installments_month_check check (extract(day from due_month) = 1);
create index if not exists loan_installments_due_idx on loan_installments (tenant_id, due_month, status);

-- money paid back outside payroll (part or full prepayment, or recovery in the final settlement)
create table if not exists loan_prepayments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  loan_id uuid not null references loans(id) on delete cascade,
  paid_on date not null,
  amount_paise bigint not null check (amount_paise > 0),
  reference text check (reference is null or length(reference) <= 120),
  closes_loan boolean not null default false,
  recorded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists loan_prepayments_loan_idx on loan_prepayments (loan_id);
create index if not exists loan_prepayments_tenant_idx on loan_prepayments (tenant_id);
create index if not exists loan_prepayments_recorded_by_idx on loan_prepayments (recorded_by);
alter table loan_prepayments enable row level security;
alter table loan_prepayments force row level security;
drop policy if exists tenant_isolation on loan_prepayments;
create policy tenant_isolation on loan_prepayments using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update, delete on loan_prepayments to erp_app;
grant select, insert, update, delete on loan_prepayments to erp_admin;
create trigger loan_prepayments_updated_at before update on loan_prepayments for each row execute function set_updated_at();

-- each EMI goes into payroll at most once (loanEmisForMonth is idempotent)
create unique index if not exists payroll_inputs_loan_installment_once
  on payroll_inputs ((source_ref->>'loan_installment_id')) where kind = 'loan_emi';
