-- pay2: daily-wage / piece-rate workers and payable units, Labour Code wage check, flexible benefit plan (FBP)
-- declarations, reimbursable component claims with bills, partial / periodic final settlements, multi-currency
-- expenses (FX rates), GL codes on salary components, Excel import keys for payroll inputs.
-- employee_salaries.status already allows 'pending_approval' (revision approvals) and form16_documents already has
-- part_b_file_id (Form 16 Part B), so neither needs a change here.

-- Daily-wage and piece-rate workers are paid per unit (day / piece) entered each month, not by attendance proration.
alter table employees drop constraint if exists employees_worker_type_check;
alter table employees add constraint employees_worker_type_check
  check (worker_type in ('permanent','contract','intern','consultant','daily','piece'));

-- payable_units: units worked in the month for daily / piece workers (stored in `days`).
alter table payroll_inputs drop constraint if exists payroll_inputs_kind_check;
alter table payroll_inputs add constraint payroll_inputs_kind_check
  check (kind in ('lop_adjust','lop_reversal','bonus','adhoc_earning','adhoc_deduction','processing_hold','payout_hold','arrear','overtime','shift_allowance',
                  'component_claim','expense','loan_emi','leave_encashment','statutory_override','pay_action','payable_units'));
-- Excel import of inputs: one row per (run, person, kind, amount, days, note), so uploading the same file twice changes nothing.
create unique index if not exists payroll_inputs_import_once on payroll_inputs ((source_ref->>'import_key')) where source_ref ? 'import_key';
-- one approved reimbursable claim → at most one payroll input
create unique index if not exists payroll_inputs_component_claim_once on payroll_inputs ((source_ref->>'component_claim_id')) where kind = 'component_claim' and source_ref ? 'component_claim_id';

-- GL code per component for the accounting exports (Tally / Zoho Books)
alter table salary_components add column if not exists gl_code text;

-- 0001 created placeholder fbp_declarations / component_claims tables that nothing ever read or wrote; replace them
-- with the shapes the FBP and claims flows need (only when the old placeholder shape is still there).
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fbp_declarations' and column_name = 'component_id') then
    drop table fbp_declarations cascade;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'component_claims' and column_name = 'payout_month') then
    drop table component_claims cascade;
  end if;
end $$;

-- Flexible benefit plan: what each person chose to put into FBP components for the year, within the component limits.
create table if not exists fbp_declarations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  fy_start date not null check (extract(month from fy_start) = 4 and extract(day from fy_start) = 1),
  items jsonb not null default '{}',          -- {CODE: annual paise}
  status text not null default 'draft' check (status in ('draft','submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, fy_start)
);
alter table fbp_declarations enable row level security;
alter table fbp_declarations force row level security;
create policy tenant_isolation on fbp_declarations using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger fbp_declarations_updated_at before update on fbp_declarations for each row execute function set_updated_at();
grant select, insert, update, delete on fbp_declarations to erp_app, erp_admin;

-- Claims against reimbursable salary components (fuel, phone, books …) with bills; approved claims are paid in payroll.
create table if not exists component_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  component_id uuid not null references salary_components(id) on delete restrict,
  fy_start date not null,
  claim_month date not null,                   -- the month the bills belong to (first of month)
  amount_paise bigint not null check (amount_paise > 0),
  allowed_paise bigint,                        -- what fits in the remaining annual limit (set when approved)
  bill_file_ids uuid[] not null default '{}',
  note text,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected','paid','withdrawn')),
  payroll_input_id uuid references payroll_inputs(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists component_claims_employee_idx on component_claims (employee_id, fy_start);
create index if not exists component_claims_tenant_status_idx on component_claims (tenant_id, status);
alter table component_claims enable row level security;
alter table component_claims force row level security;
create policy tenant_isolation on component_claims using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger component_claims_updated_at before update on component_claims for each row execute function set_updated_at();
grant select, insert, update, delete on component_claims to erp_app, erp_admin;

-- Final settlements paid in parts: each part has its own month and statement and is finalised on its own.
create table if not exists fnf_settlement_parts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  settlement_id uuid not null references fnf_settlements(id) on delete cascade,
  part_no int not null check (part_no between 1 and 12),
  settlement_month date not null,
  item_keys text[] not null default '{}',
  net_paise bigint,
  status text not null default 'draft' check (status in ('draft','finalized')),
  statement_file_id uuid references files(id) on delete set null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (settlement_id, part_no)
);
alter table fnf_settlement_parts enable row level security;
alter table fnf_settlement_parts force row level security;
create policy tenant_isolation on fnf_settlement_parts using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger fnf_settlement_parts_updated_at before update on fnf_settlement_parts for each row execute function set_updated_at();
grant select, insert, update, delete on fnf_settlement_parts to erp_app, erp_admin;

-- Exchange rates for expenses in other currencies: INR per one unit of the currency, dated; finance edits them, a daily job may add fetched ones.
create table if not exists fx_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$' and currency <> 'INR'),
  as_of date not null,
  rate_micro bigint not null check (rate_micro > 0),   -- INR per unit × 1,000,000 (integer, no floats)
  source text not null default 'manual' check (source in ('manual','fetched')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, currency, as_of)
);
alter table fx_rates enable row level security;
alter table fx_rates force row level security;
create policy tenant_isolation on fx_rates using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger fx_rates_updated_at before update on fx_rates for each row execute function set_updated_at();
grant select, insert, update, delete on fx_rates to erp_app, erp_admin;
