-- time3: per-event leave grants, trusted clock-in devices (first clock-in approval), ADMS device settings.
-- Capture-policy options (selfie, first-clock-in approval, accuracy threshold) and accrual stop rules live in the
-- existing jsonb columns (capture_policies.mobile, leave_plan_rules.accrual), so no new columns are needed for them.

-- Event-based leave (marriage, bereavement …): HR grants N days for one event, valid between two dates. A request of that
-- leave type consumes the grant; whatever is left after valid_to lapses in the nightly run.
create table if not exists leave_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete restrict,
  event text not null,                              -- what it's for, in the grantor's words
  days numeric(6,2) not null check (days > 0 and days <= 365),
  valid_from date not null, valid_to date not null,
  note text,
  status text not null default 'active' check (status in ('active','cancelled','lapsed')),
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (valid_to >= valid_from)
);
create index if not exists leave_grants_employee_idx on leave_grants (employee_id, leave_type_id, status);
create index if not exists leave_grants_tenant_idx on leave_grants (tenant_id);
alter table leave_grants enable row level security;
alter table leave_grants force row level security;
create policy tenant_isolation on leave_grants using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger leave_grants_updated_at before update on leave_grants for each row execute function set_updated_at();
grant select, insert, update, delete on leave_grants to erp_app, erp_admin;

alter table leave_requests add column if not exists grant_id uuid references leave_grants(id) on delete set null;
create index if not exists leave_requests_grant_idx on leave_requests (grant_id) where grant_id is not null;

-- A browser/device the person has clocked in from before (inside a given location). The first clock-in from a new one
-- waits for the manager when the capture policy says so; approval adds the row.
create table if not exists clock_in_trust (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  device_hash text not null,                        -- sha256 of the browser's random clock-in id; never the raw id
  geofence_id uuid references geofences(id) on delete cascade,
  label text,
  approved_request_id uuid references attendance_requests(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique nulls not distinct (employee_id, device_hash, geofence_id)
);
create index if not exists clock_in_trust_tenant_idx on clock_in_trust (tenant_id);
alter table clock_in_trust enable row level security;
alter table clock_in_trust force row level security;
create policy tenant_isolation on clock_in_trust using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger clock_in_trust_updated_at before update on clock_in_trust for each row execute function set_updated_at();
grant select, insert, update, delete on clock_in_trust to erp_app, erp_admin;

-- ADMS ("iclock") push devices send local time with no zone and are identified by serial number only.
alter table devices add column if not exists protocol text not null default 'json' check (protocol in ('json','adms'));
alter table devices add column if not exists timezone text not null default 'Asia/Kolkata';
alter table devices add column if not exists clock_offset_seconds int not null default 0 check (clock_offset_seconds between -86400 and 86400);
alter table devices add column if not exists last_error text;
