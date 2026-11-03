-- time2: overtime settlement, shift allowances, roster, devices, notification settings.
-- The tables (overtime_policies, pay_codes, shift_allowance_policies, roster_entries, devices, shift_rules,
-- notification_settings) already exist from 0001; this only adds the idempotency keys and lookups they need.

-- One payroll input per person and month for settled overtime / shift allowance: re-running a settlement updates, never duplicates.
create unique index if not exists payroll_inputs_overtime_once on payroll_inputs ((source_ref->>'overtime_key')) where kind = 'overtime' and source_ref ? 'overtime_key';
create unique index if not exists payroll_inputs_shift_allowance_once on payroll_inputs ((source_ref->>'shift_allowance_key')) where kind = 'shift_allowance' and source_ref ? 'shift_allowance_key';

create index if not exists roster_entries_tenant_date_idx on roster_entries (tenant_id, date);
create index if not exists devices_tenant_idx on devices (tenant_id);
create index if not exists punches_device_idx on punches (device_id) where device_id is not null;

-- settled overtime per person and month: what the payroll input / comp-off credit was built from, so the admin page can show it
create table if not exists overtime_settlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  month date not null,
  policy_id uuid references overtime_policies(id) on delete set null,
  minutes int not null default 0,
  mode text not null check (mode in ('pay','comp_off','none')),
  amount_paise bigint not null default 0,
  comp_off_days numeric(5,2) not null default 0,
  payroll_input_id uuid references payroll_inputs(id) on delete set null,
  detail jsonb not null default '{}',
  settled_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, month)
);
create index if not exists overtime_settlements_tenant_month_idx on overtime_settlements (tenant_id, month);
alter table overtime_settlements enable row level security;
alter table overtime_settlements force row level security;
create policy tenant_isolation on overtime_settlements using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger overtime_settlements_updated_at before update on overtime_settlements for each row execute function set_updated_at();
grant select, insert, update, delete on overtime_settlements to erp_app, erp_admin;
