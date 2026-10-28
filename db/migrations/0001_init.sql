-- erp: multi-tenant HRMS schema (Postgres 15+)
-- Conventions
--   * every tenant-owned table: id uuid pk, tenant_id (on delete cascade = tenant purge), created_at, updated_at
--   * access: Postgres RLS on tenant_id = current_setting('app.tenant_id'); the app connects as role erp_app
--     (no BYPASSRLS) and runs `select set_config('app.tenant_id', $1, true)` at the start of every transaction.
--     Role/scope permissions (who inside a tenant may see what) are checked in the data layer.
--   * money: bigint paise + currency (INR default). Leave/attendance quantities: numeric days.
--   * times: timestamptz (UTC). Calendar dates (leave, attendance, payroll month): date.
--   * people are never hard-deleted (status = relieved); history tables use on delete restrict.
--   * indexes on every foreign key are created automatically at the end of this file.

create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;

create or replace function app_tenant() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function set_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

-- =========================================================================
-- 1. Platform: tenants, auth, billing
-- =========================================================================
create table tenants (
  id uuid primary key default gen_random_uuid(),
  subdomain citext not null unique check (subdomain ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  name text not null,
  status text not null default 'trial' check (status in ('trial','active','past_due','suspended','cancelled')),
  plan text not null default 'core' check (plan in ('core','plus','pro')),
  addons text[] not null default '{}',
  seats int not null default 25 check (seats > 0),
  trial_ends_at timestamptz,
  timezone text not null default 'Asia/Kolkata',
  branding jsonb not null default '{}',
  auth_settings jsonb not null default '{"password":true,"google":false,"microsoft":false,"mobile_otp":false,"mfa":"optional"}',
  setup_state jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email citext not null,
  phone text,
  password_hash text,
  email_verified_at timestamptz,
  mfa_enabled boolean not null default false,
  status text not null default 'invited' check (status in ('invited','active','disabled')),
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  ip inet, user_agent text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table auth_accounts (            -- SSO identities (Google, Microsoft, OIDC)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft','oidc')),
  subject text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, provider, subject)
);

create table auth_tokens (              -- invites, password resets, OTPs, email verification
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  purpose text not null check (purpose in ('invite','reset_password','verify_email','login_otp','mfa_otp','esign_otp')),
  target text not null,                -- email or phone
  token_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on auth_tokens (tenant_id, target, purpose) where consumed_at is null;

create table login_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  email citext,
  method text not null check (method in ('password','google','microsoft','oidc','mobile_otp')),
  success boolean not null,
  ip inet, user_agent text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on login_events (tenant_id, created_at desc);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  plan text not null check (plan in ('core','plus','pro')),
  seats int not null check (seats > 0),
  billing_cycle text not null default 'quarterly' check (billing_cycle in ('monthly','quarterly','yearly')),
  status text not null check (status in ('created','active','past_due','halted','cancelled')),
  razorpay_subscription_id text unique,
  current_period_end timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  number text not null unique,
  amount_paise bigint not null check (amount_paise >= 0),
  gst_paise bigint not null default 0 check (gst_paise >= 0),
  currency char(3) not null default 'INR',
  status text not null check (status in ('issued','paid','failed','void')),
  razorpay_payment_id text,
  issued_at timestamptz not null default now(), paid_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table webhook_events (           -- inbound webhooks, idempotency by (provider, event_id)
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table counters (                 -- per-tenant human-readable sequences (ticket no, claim no, ...)
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  value bigint not null default 0,
  primary key (tenant_id, key)
);

create table files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  storage_key text not null unique,
  name text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes between 0 and 26214400), -- 25 MB cap
  uploaded_by uuid references users(id) on delete set null,
  scan_status text not null default 'pending' check (scan_status in ('pending','clean','infected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 2. Org structure
-- =========================================================================
create table legal_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  pan text, tan text, gstin text,
  pf_establishment_code text, esi_code text, pt_registration jsonb not null default '{}', lwf_registration jsonb not null default '{}',
  address jsonb not null default '{}',
  country char(2) not null default 'IN',
  currency char(3) not null default 'INR',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table business_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid references legal_entities(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table holiday_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  year int not null check (year between 2000 and 2100),
  floater_limit int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name, year)
);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  holiday_list_id uuid not null references holiday_lists(id) on delete cascade,
  name text not null,
  date date not null,
  is_floater boolean not null default false,
  description text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (holiday_list_id, date, name)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  address jsonb not null default '{}',
  country char(2) not null default 'IN',
  state_code text,                       -- drives PT / LWF
  timezone text not null default 'Asia/Kolkata',
  default_holiday_list_id uuid references holiday_lists(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_id uuid references departments(id) on delete restrict,
  business_unit_id uuid references business_units(id) on delete set null,
  name text not null,
  head_employee_id uuid,                 -- fk added after employees
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, parent_id, name)
);

create table designations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, title)
);

create table bands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  rank int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table group_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  group_type_id uuid not null references group_types(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (group_type_id, name)
);

create table probation_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  duration_days int not null check (duration_days >= 0),
  auto_confirm boolean not null default false,
  confirmation_letter_template_id uuid,  -- fk added after letter_templates
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table notice_period_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  days int not null check (days >= 0),
  probation_days int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 3. Time policies referenced by employees (leave, shifts, capture, penalties)
-- =========================================================================
create table leave_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  code text not null,
  kind text not null check (kind in ('regular','incident','comp_off','unpaid')),
  is_paid boolean not null default true,
  unit text not null default 'day' check (unit in ('day','hour')),
  color text not null default '#4F46E5',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table leave_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  year_start text not null check (year_start in ('jan','apr','joining_date')), -- immutable after create (app-enforced)
  policy_file_id uuid references files(id) on delete set null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table leave_plan_rules (           -- one rule-set per leave type inside a plan
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  leave_plan_id uuid not null references leave_plans(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete restrict,
  yearly_quota numeric(6,2),               -- null = unlimited
  accrual jsonb not null default '{"frequency":"monthly","day":1,"upfront":false,"prorate_joining":true}',
  application jsonb not null default '{}', -- notice, backdate, max consecutive, attachment after n, half day, negative limit, sandwich
  approval jsonb not null default '{}',    -- workflow id / auto approve
  year_end jsonb not null default '{"action":"reset"}', -- carry / lapse / encash
  probation jsonb not null default '{}',
  notice_period jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (leave_plan_id, leave_type_id)
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  code text not null,
  kind text not null default 'fixed' check (kind in ('fixed','flexible')),
  timings jsonb not null,                  -- {"mon":{"start":"09:30","end":"18:30"},...}; end < start = overnight
  break_minutes int not null default 60 check (break_minutes >= 0),
  grace_minutes int not null default 0 check (grace_minutes >= 0),
  half_day_minutes int,
  auto_assign jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table weekly_off_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  pattern jsonb not null,                  -- {"sat":["off","work","off","work","work"],"sun":"off"} per week-of-month, 'half' allowed
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table capture_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  web jsonb not null default '{"enabled":true,"comment_required":false,"ip_ranges":[]}',
  mobile jsonb not null default '{"enabled":true,"geofence_ids":[],"selfie":false,"first_clock_in_approval":false}',
  remote jsonb not null default '{"wfh":true,"od":true}',
  limits jsonb not null default '{"regularization_per_month":3,"regularization_past_days":7,"partial_day_minutes_per_month":240}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table penalization_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  late_arrival jsonb, hours_shortage jsonb, no_attendance jsonb, missing_swipe jsonb,
  deduct_from_leave_type_ids uuid[] not null default '{}',  -- order; LOP fallback
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table expense_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  base_currency char(3) not null default 'INR',
  allow_future_dated boolean not null default false,
  submission_deadline_days int,
  approval jsonb not null default '{}',
  advance_rules jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table pay_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid not null references legal_entities(id) on delete restrict,
  name text not null,
  currency char(3) not null default 'INR',
  cycle text not null default 'monthly' check (cycle in ('monthly')),
  attendance_cutoff_day int not null default 25 check (attendance_cutoff_day between 1 and 31),
  payable_days_basis text not null default 'calendar' check (payable_days_basis in ('calendar','fixed_30','working')),
  tax_settings jsonb not null default '{}',   -- declaration windows, proof cut-off, approval
  filing jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- =========================================================================
-- 4. Employees
-- =========================================================================
create table employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid unique references users(id) on delete set null,
  employee_number text not null,
  first_name text not null, middle_name text, last_name text,
  display_name text not null,
  work_email citext not null,
  personal_email citext,
  mobile text,
  dob date,
  gender text check (gender in ('male','female','non_binary','undisclosed')),
  marital_status text check (marital_status in ('single','married','divorced','widowed','undisclosed')),
  blood_group text,
  nationality char(2),
  photo_file_id uuid references files(id) on delete set null,
  bio jsonb not null default '{}',            -- summary, love_about_job, hobbies
  addresses jsonb not null default '{}',      -- current, permanent
  -- job
  legal_entity_id uuid references legal_entities(id) on delete restrict,
  business_unit_id uuid references business_units(id) on delete restrict,
  department_id uuid references departments(id) on delete restrict,
  location_id uuid references locations(id) on delete restrict,
  designation_id uuid references designations(id) on delete restrict,
  secondary_title text,
  band_id uuid references bands(id) on delete set null,
  manager_id uuid references employees(id) on delete set null,
  l2_manager_id uuid references employees(id) on delete set null,
  dotted_manager_id uuid references employees(id) on delete set null,
  joining_date date not null,
  worker_type text not null default 'permanent' check (worker_type in ('permanent','contract','intern','consultant')),
  time_type text not null default 'full_time' check (time_type in ('full_time','part_time')),
  status text not null default 'active' check (status in ('preboarding','active','notice','relieved')),
  probation_policy_id uuid references probation_policies(id) on delete set null,
  probation_end_date date,
  probation_status text not null default 'none' check (probation_status in ('none','in_probation','extended','confirmed')),
  notice_period_policy_id uuid references notice_period_policies(id) on delete set null,
  exit_date date,
  is_private boolean not null default false,
  -- assigned policies
  leave_plan_id uuid references leave_plans(id) on delete set null,
  holiday_list_id uuid references holiday_lists(id) on delete set null,
  capture_policy_id uuid references capture_policies(id) on delete set null,
  penalization_policy_id uuid references penalization_policies(id) on delete set null,
  expense_policy_id uuid references expense_policies(id) on delete set null,
  pay_group_id uuid references pay_groups(id) on delete set null,
  attendance_number text,                     -- biometric device user id
  custom jsonb not null default '{}',
  search tsvector generated always as (to_tsvector('simple', coalesce(display_name,'') || ' ' || employee_number || ' ' || work_email)) stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, employee_number),
  unique (tenant_id, work_email),
  check (manager_id is null or manager_id <> id)
);
create index on employees using gin (search);
create index on employees using gin (display_name gin_trgm_ops);
create index on employees (tenant_id, status);
create index on employees (tenant_id, (extract(month from dob)), (extract(day from dob)));

alter table departments add constraint departments_head_fk foreign key (head_employee_id) references employees(id) on delete set null;

create table employee_groups (
  employee_id uuid not null references employees(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  primary key (employee_id, group_id)
);

create table employee_relations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  relation text not null check (relation in ('father','mother','spouse','child','sibling','other')),
  name text not null, gender text, dob date, email text, mobile text, profession text,
  is_nominee boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table employee_educations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  degree text not null, branch text, institution text, score text,
  start_year int, end_year int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table employee_experiences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  company text not null, title text, location text, description text,
  start_date date, end_date date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table employee_identities (       -- PAN, Aadhaar, passport, voter id, DL; numbers encrypted in app (AES-GCM)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  kind text not null check (kind in ('pan','aadhaar','passport','voter_id','driving_licence','other')),
  number_enc bytea not null,
  number_last4 text,
  name_on_doc text, expiry_date date,
  file_id uuid references files(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, kind)
);

create table employee_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  bank_name text not null, ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_number_enc bytea not null, account_last4 text not null,
  holder_name text not null,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index on employee_bank_accounts (employee_id) where is_primary;

create table employee_statutory (
  employee_id uuid primary key references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  pf_enabled boolean not null default true,
  uan text, pf_number text,
  pf_on_full_wage boolean not null default false,
  esi_enabled boolean not null default true, esi_number text,
  pt_state text, lwf_state text,
  tax_regime text not null default 'new' check (tax_regime in ('old','new')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity text not null default 'employee' check (entity in ('employee','candidate','job','expense')),
  section text not null,
  key text not null,
  label text not null,
  type text not null check (type in ('text','long_text','number','date','select','multi_select','boolean','file','email','phone')),
  options jsonb,
  required boolean not null default false,
  view_roles text[] not null default '{employee,manager,hr_admin}',
  edit_roles text[] not null default '{hr_admin}',
  position int not null default 0,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, entity, key)
);

create table profile_change_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  section text not null,
  changes jsonb not null,              -- {field: {old, new}}
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table job_changes (                -- transfers, promotions, manager changes; can be future-dated
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  kind text not null check (kind in ('transfer','promotion','manager_change','designation_change','policy_change','other')),
  effective_date date not null,
  changes jsonb not null,
  status text not null default 'scheduled' check (status in ('scheduled','applied','cancelled')),
  letter_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on job_changes (effective_date) where status = 'scheduled';

create table timeline_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  kind text not null,                  -- joined, probation_confirmed, transfer, promotion, revision, exit, ...
  effective_date date not null,
  data jsonb not null default '{}',
  actor_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on timeline_events (employee_id, effective_date desc);

-- =========================================================================
-- 5. RBAC, approvals, notifications, audit
-- =========================================================================
create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,                   -- global_admin, hr_admin, payroll_admin, finance, recruiter, it_admin, custom_*
  name text not null,
  is_system boolean not null default false,
  permissions text[] not null default '{}',  -- 'employees.read', 'payroll.run', ...
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table role_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  scopes jsonb not null default '[]',  -- [] = whole tenant; [{"type":"department","ids":[...]}]
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (role_id, employee_id)
);

create table approval_workflows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_type text not null,           -- leave, attendance_request, expense_claim, profile_change, asset_request, requisition, offer, loan, ...
  name text not null,
  conditions jsonb not null default '[]',
  levels jsonb not null,               -- [{"approver":"manager"},{"approver":"role","role":"hr_admin"},{"approver":"employee","id":"..."}]
  auto_approve_after_days int,
  priority int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on approval_workflows (tenant_id, entity_type, priority) where is_active;

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid references approval_workflows(id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  requester_employee_id uuid not null references employees(id) on delete cascade,
  summary text not null,
  current_level int not null default 1,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (entity_type, entity_id)
);

create table approval_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  request_id uuid not null references approval_requests(id) on delete cascade,
  level int not null,
  approver_employee_id uuid not null references employees(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting','pending','approved','rejected','skipped')),
  comment text,
  acted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on approval_steps (approver_employee_id, status) where status = 'pending';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null, body text, link text,
  read_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on notifications (user_id, created_at desc) where read_at is null;

create table notification_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  event text not null,
  channels text[] not null default '{in_app,email}',
  template jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, event)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  entity_type text not null, entity_id uuid,
  action text not null,
  diff jsonb,
  ip inet,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on audit_logs (tenant_id, created_at desc);
create index on audit_logs (entity_type, entity_id);

-- =========================================================================
-- 6. Home & Engage
-- =========================================================================
create table quick_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  label text not null, url text not null check (url ~ '^https?://'),
  position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table badges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, icon text not null, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  author_employee_id uuid not null references employees(id) on delete cascade,
  kind text not null check (kind in ('post','announcement','poll','praise')),
  audience jsonb not null default '{"type":"org"}',  -- org | department ids | location ids
  title text, body text,
  media_file_ids uuid[] not null default '{}',
  badge_id uuid references badges(id) on delete set null,
  poll jsonb,                                         -- {"multiple":false,"anonymous":false,"ends_at":...}
  pinned_until timestamptz, publish_at timestamptz not null default now(), expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on posts (tenant_id, publish_at desc);

create table praise_recipients (
  post_id uuid not null references posts(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  primary key (post_id, employee_id)
);

create table poll_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  label text not null, position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table poll_votes (
  option_id uuid not null references poll_options(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (option_id, employee_id)
);

create table post_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  author_employee_id uuid not null references employees(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table post_reactions (
  post_id uuid not null references posts(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null default 'like' check (kind in ('like','celebrate','love','insightful')),
  created_at timestamptz not null default now(),
  primary key (post_id, employee_id)
);

create table surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null, description text,
  is_anonymous boolean not null default false,
  min_responses_to_show int not null default 5,
  audience jsonb not null default '{"type":"org"}',
  schedule jsonb,                      -- {"starts_at","ends_at","recurrence":"monthly"}
  status text not null default 'draft' check (status in ('draft','live','closed')),
  created_by uuid references employees(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table survey_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  survey_id uuid not null references surveys(id) on delete cascade,
  type text not null check (type in ('short_text','long_text','dropdown','single','multi','yes_no','nps','opinion_scale','rating','date')),
  prompt text not null, options jsonb, required boolean not null default true, position int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table survey_participations (    -- who responded (kept separate so anonymous answers are unlinkable)
  survey_id uuid not null references surveys(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  round int not null default 1,
  responded_at timestamptz not null default now(),
  primary key (survey_id, employee_id, round)
);

create table survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  survey_id uuid not null references surveys(id) on delete cascade,
  employee_id uuid references employees(id) on delete set null,   -- null when anonymous
  round int not null default 1,
  answers jsonb not null,              -- {question_id: value}
  segment jsonb not null default '{}', -- department/location snapshot for filtering
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 7. Documents, letters, e-sign
-- =========================================================================
create table document_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  access jsonb not null default '{"type":"org"}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table org_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  folder_id uuid not null references document_folders(id) on delete cascade,
  title text not null, description text,
  file_id uuid not null references files(id) on delete restrict,
  requires_ack boolean not null default false,
  block_portal_until_ack boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table document_acks (
  document_id uuid not null references org_documents(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  viewed_at timestamptz, acknowledged_at timestamptz,
  primary key (document_id, employee_id)
);

create table employee_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  category text not null check (category in ('identity','education','experience','letter','other')),
  doc_type text not null,
  number text,
  file_id uuid not null references files(id) on delete restrict,
  expiry_date date,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  verified_by uuid references users(id) on delete set null, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on employee_documents (expiry_date) where expiry_date is not null;

create table letter_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('offer','appointment','confirmation','promotion','transfer','relieving','experience','salary_revision','other')),
  body_html text not null,             -- {{employee.display_name}} placeholders
  signatories jsonb not null default '[]',
  candidate_signature boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table probation_policies add constraint probation_letter_fk foreign key (confirmation_letter_template_id) references letter_templates(id) on delete set null;

create table generated_letters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid references letter_templates(id) on delete set null,
  employee_id uuid references employees(id) on delete cascade,
  candidate_id uuid,                   -- fk added after candidates
  data jsonb not null default '{}',
  file_id uuid references files(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','pending_signature','signed','published','void')),
  published_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (employee_id is not null or candidate_id is not null)
);
alter table job_changes add constraint job_changes_letter_fk foreign key (letter_id) references generated_letters(id) on delete set null;

create table signature_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  letter_id uuid not null references generated_letters(id) on delete cascade,
  signer_employee_id uuid references employees(id) on delete cascade,
  signer_email citext not null,
  sign_order int not null default 1,
  status text not null default 'waiting' check (status in ('waiting','pending','signed','declined')),
  signature_file_id uuid references files(id) on delete set null,
  signed_ip inet, signed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 8. Lifecycle: tasks, onboarding, probation, exit
-- =========================================================================
create table task_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('preboarding','onboarding','exit','general')),
  name text not null,
  criteria jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table task_template_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references task_templates(id) on delete cascade,
  title text not null, description text,
  type text not null default 'simple' check (type in ('simple','profile_field','document_upload','acknowledge','approval')),
  owner jsonb not null,                -- {"type":"role","role":"it_admin"} | {"type":"manager"} | {"type":"self"} | {"type":"employee","id":...}
  due_offset_days int not null default 0,   -- relative to joining date / last working day
  config jsonb not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table lifecycle_processes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('preboarding','onboarding','exit')),
  employee_id uuid not null references employees(id) on delete cascade,
  template_id uuid references task_templates(id) on delete set null,
  status text not null default 'in_progress' check (status in ('in_progress','completed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index on lifecycle_processes (employee_id, kind) where status = 'in_progress';

create table tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  process_id uuid references lifecycle_processes(id) on delete cascade,
  subject_employee_id uuid references employees(id) on delete cascade,
  assignee_employee_id uuid references employees(id) on delete set null,
  template_item_id uuid references task_template_items(id) on delete set null,
  title text not null, type text not null default 'simple', config jsonb not null default '{}',
  due_date date,
  status text not null default 'open' check (status in ('open','done','skipped')),
  completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on tasks (assignee_employee_id, status, due_date);

create table exit_reasons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('resignation','termination','other')),
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, kind, name)
);

create table exit_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  kind text not null check (kind in ('resignation','company_action')),
  reason_id uuid references exit_reasons(id) on delete set null,
  comments text,
  resignation_date date not null,
  requested_lwd date,
  last_working_date date not null,
  notice_waived_days int not null default 0,
  ok_to_rehire boolean,
  status text not null default 'under_review' check (status in ('under_review','in_progress','exited','withdrawn','rejected')),
  initiated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (last_working_date >= resignation_date)
);
create unique index on exit_requests (employee_id) where status in ('under_review','in_progress');

-- =========================================================================
-- 9. Assets & helpdesk
-- =========================================================================
create table asset_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table asset_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category_id uuid not null references asset_categories(id) on delete restrict,
  name text not null, requires_ack boolean not null default true, requestable boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (category_id, name)
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  type_id uuid not null references asset_types(id) on delete restrict,
  tag text not null, name text not null, serial_number text,
  condition text not null default 'good' check (condition in ('new','good','fair','damaged','lost')),
  status text not null default 'available' check (status in ('available','assigned','in_repair','retired')),
  purchase_date date, cost_paise bigint, currency char(3) not null default 'INR',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, tag)
);

create table asset_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete restrict,
  employee_id uuid not null references employees(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  returned_at timestamptz, return_condition text, recovery_paise bigint not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index on asset_assignments (asset_id) where returned_at is null;   -- one holder at a time

create table asset_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  type_id uuid not null references asset_types(id) on delete restrict,
  kind text not null check (kind in ('new','replacement')),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','fulfilled','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table ticket_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  assignee_employee_ids uuid[] not null default '{}',
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  first_response_sla_mins int, resolution_sla_mins int,
  escalate_to_employee_id uuid references employees(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number bigint not null,
  category_id uuid not null references ticket_categories(id) on delete restrict,
  raised_by_employee_id uuid not null references employees(id) on delete cascade,
  assignee_employee_id uuid references employees(id) on delete set null,
  title text not null, description text,
  priority text not null check (priority in ('low','medium','high')),
  status text not null default 'open' check (status in ('open','in_progress','closed')),
  first_response_due_at timestamptz, resolution_due_at timestamptz,
  first_responded_at timestamptz, closed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index on tickets (tenant_id, status, resolution_due_at);

create table ticket_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  author_employee_id uuid references employees(id) on delete set null,
  body text not null, is_internal boolean not null default false,
  file_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 10. Leave
-- =========================================================================
create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete restrict,
  from_date date not null, to_date date not null,
  from_half text not null default 'full' check (from_half in ('full','second')),  -- 'second' = starts at second half
  to_half text not null default 'full' check (to_half in ('full','first')),       -- 'first' = ends after first half
  days numeric(6,2) not null check (days > 0),     -- includes sandwich days
  note text,
  notify_employee_ids uuid[] not null default '{}',
  attachment_file_ids uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  applied_by uuid references users(id) on delete set null,
  -- half-day slots: day d first half = 2d, second half = 2d+1; used to block overlapping requests
  slots int4range generated always as (
    int4range(
      (from_date - date '2000-01-01') * 2 + (case when from_half = 'second' then 1 else 0 end),
      (to_date - date '2000-01-01') * 2 + (case when to_half = 'first' then 1 else 2 end))
  ) stored,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (to_date >= from_date),
  constraint leave_no_overlap exclude using gist (employee_id with =, slots with &&) where (status in ('pending','approved'))
);

create table leave_ledger (               -- every balance change; balance = sum(amount)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id) on delete restrict,
  cycle_start date not null,           -- leave year this entry belongs to
  entry_date date not null,
  kind text not null check (kind in ('opening','accrual','use','use_reversal','adjust','encash','carry_forward','lapse','penalty','comp_off_credit','expiry')),
  amount numeric(7,2) not null,        -- + credit, - debit
  ref_type text, ref_id uuid,
  note text,
  idempotency_key text,                -- e.g. accrual:{employee}:{type}:{2026-10}
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index on leave_ledger (employee_id, leave_type_id, cycle_start);

create view leave_balances as
  select tenant_id, employee_id, leave_type_id, cycle_start,
         sum(amount) as balance,
         sum(amount) filter (where kind in ('accrual','opening','carry_forward','comp_off_credit','adjust') and amount > 0) as credited,
         -sum(amount) filter (where kind in ('use','use_reversal','penalty')) as used
  from leave_ledger group by 1,2,3,4;

create table comp_off_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  worked_dates date[] not null,
  days numeric(5,2) not null check (days > 0),
  note text, file_ids uuid[] not null default '{}',
  expires_on date,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table floater_choices (
  holiday_id uuid not null references holidays(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (holiday_id, employee_id)
);

-- =========================================================================
-- 11. Attendance, shifts, overtime
-- =========================================================================
create table shift_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete restrict,
  period daterange not null,           -- [from, to) ; to = null means open-ended
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint shift_no_overlap exclude using gist (employee_id with =, period with &&)
);

create table weekly_off_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  policy_id uuid not null references weekly_off_policies(id) on delete restrict,
  period daterange not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint weekly_off_no_overlap exclude using gist (employee_id with =, period with &&)
);

create table roster_entries (            -- day-level override from the roster board / rotations
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  date date not null,
  shift_id uuid references shifts(id) on delete restrict,   -- null = weekly off
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, date)
);

create table shift_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  allowed_shift_ids uuid[] not null default '{}',
  request_window_days int, max_requests_per_month int,
  allow_on_off_days boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table geofences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m int not null check (radius_m between 20 and 5000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  name text not null, vendor text not null default 'generic', serial text not null,
  api_key_hash text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, serial)
);

create table punches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  at timestamptz not null,
  direction text not null default 'auto' check (direction in ('in','out','auto')),
  source text not null check (source in ('web','mobile','biometric','api','regularization')),
  lat double precision, lng double precision, accuracy_m real,
  ip inet,
  selfie_file_id uuid references files(id) on delete set null,
  device_id uuid references devices(id) on delete set null,
  external_id text,                    -- device log id → idempotent ingest
  comment text,
  status text not null default 'valid' check (status in ('valid','pending_approval','rejected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (device_id, external_id)
);
create index on punches (employee_id, at);

create table attendance_days (            -- derived by the processing job; recomputed when inputs change
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  date date not null,
  shift_id uuid references shifts(id) on delete set null,
  day_type text not null check (day_type in ('working','weekly_off','half_weekly_off','holiday')),
  first_in timestamptz, last_out timestamptz,
  gross_minutes int not null default 0, effective_minutes int not null default 0,
  late_minutes int not null default 0, early_minutes int not null default 0,
  status text not null check (status in ('present','absent','half_day','leave','half_leave','wfh','on_duty','weekly_off','holiday','not_joined')),
  leave_request_id uuid references leave_requests(id) on delete set null,
  penalties jsonb not null default '[]',
  overtime_minutes int not null default 0,
  is_locked boolean not null default false,   -- true once payroll for the month is finalized
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, date)
);
create index on attendance_days (tenant_id, date);

create table attendance_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  kind text not null check (kind in ('regularization','partial_day','wfh','on_duty','remote_clock_in','shift_change','weekly_off_change','overtime')),
  from_date date not null, to_date date not null,
  payload jsonb not null default '{}',
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (to_date >= from_date)
);
create index on attendance_requests (employee_id, from_date);

create table pay_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('multiplier','fixed_per_hour','lump_sum')),
  value numeric(12,4),                 -- multiplier or paise per hour
  formula text,                        -- lump sum formula
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table overtime_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  rules jsonb not null,                -- per day_type: {mode: pay|comp_off, coverage, min_minutes, pay_code_id, tiers, basis, rounding, approval}
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table employees add column overtime_policy_id uuid references overtime_policies(id) on delete set null;

create table shift_allowance_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  shift_ids uuid[] not null,
  amount_paise bigint not null check (amount_paise >= 0), per text not null default 'day' check (per in ('day','shift')),
  component_code text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 12. Payroll
-- =========================================================================
create table salary_components (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),   -- used in formulas as [CODE]
  name text not null,
  kind text not null check (kind in ('earning','reimbursable','deduction','reimbursement','adhoc_earning','adhoc_deduction','bonus','employer_contribution')),
  is_taxable boolean not null default true,
  tax_section text,                    -- e.g. 10(13A) HRA
  annual_max_paise bigint,
  lop_prorated boolean not null default true,
  frequency text not null default 'monthly' check (frequency in ('monthly','quarterly','half_yearly','yearly','one_time')),
  on_payslip boolean not null default true,
  in_arrears boolean not null default true,
  is_fbp boolean not null default false,
  pf_wage boolean not null default false, esi_wage boolean not null default true,
  claim_rules jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table salary_structures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pay_group_id uuid not null references pay_groups(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (pay_group_id, name)
);

create table salary_structure_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  structure_id uuid not null references salary_structures(id) on delete cascade,
  component_id uuid not null references salary_components(id) on delete restrict,
  calc text not null check (calc in ('flat','pct_ctc','pct_gross','formula','balancing')),
  value numeric(14,4),
  formula text,                        -- e.g. [BASIC]*0.4
  position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (structure_id, component_id)
);
create unique index on salary_structure_lines (structure_id) where calc = 'balancing';

create table employee_salaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  structure_id uuid not null references salary_structures(id) on delete restrict,
  ctc_paise bigint not null check (ctc_paise > 0),
  currency char(3) not null default 'INR',
  effective_from date not null,
  breakup jsonb not null,              -- frozen {CODE: monthly_paise}
  reason text not null default 'joining' check (reason in ('joining','revision','promotion','correction')),
  arrears_from_month date,
  status text not null default 'active' check (status in ('draft','pending_approval','active','superseded')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table statutory_rates (            -- global, versioned; not tenant-scoped (read-only for tenants)
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('pf','esi','pt','lwf','income_tax','gratuity','labour_code')),
  state_code text,                     -- for pt / lwf
  regime text,                         -- for income_tax: old | new
  effective_from date not null,
  effective_to date,
  config jsonb not null,               -- slabs / rates / ceilings
  source_note text not null,           -- citation + 'verified by CA on ...'
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (kind, state_code, regime, effective_from)
);

create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pay_group_id uuid not null references pay_groups(id) on delete restrict,
  period_month date not null check (extract(day from period_month) = 1),
  currency char(3) not null default 'INR',
  status text not null default 'draft' check (status in ('draft','in_progress','finalized','payslips_released','paid','rolled_back')),
  step_state jsonb not null default '{}',
  totals jsonb not null default '{}',
  finalized_at timestamptz, finalized_by uuid references users(id) on delete set null,
  lock_version int not null default 0,   -- optimistic lock against concurrent edits
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index on payroll_runs (pay_group_id, period_month) where status <> 'rolled_back';

create table payroll_inputs (             -- everything that changes a month's pay before compute
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pay_group_id uuid not null references pay_groups(id) on delete cascade,
  period_month date not null,
  employee_id uuid not null references employees(id) on delete restrict,
  kind text not null check (kind in ('lop_adjust','lop_reversal','bonus','adhoc_earning','adhoc_deduction','processing_hold','payout_hold','arrear','overtime','shift_allowance','component_claim','expense','loan_emi','leave_encashment','statutory_override','pay_action')),
  component_id uuid references salary_components(id) on delete restrict,
  amount_paise bigint,
  days numeric(6,2),
  source_month date,
  source_ref jsonb,
  action text not null default 'pay' check (action in ('pay','hold','void','paid_outside','partial')),
  note text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on payroll_inputs (pay_group_id, period_month, employee_id);

create table payroll_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null references payroll_runs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  salary_id uuid references employee_salaries(id) on delete restrict,
  period_days numeric(5,2) not null,
  payable_days numeric(5,2) not null,
  lop_days numeric(5,2) not null default 0,
  earnings jsonb not null default '{}',     -- {CODE: paise}
  deductions jsonb not null default '{}',
  employer jsonb not null default '{}',     -- employer PF, ESI, LWF
  statutory jsonb not null default '{}',    -- calc details incl. TDS projection
  gross_paise bigint not null default 0,
  total_deductions_paise bigint not null default 0,
  net_paise bigint not null default 0,
  action text not null default 'process' check (action in ('process','hold_processing','hold_payout','void','paid_outside')),
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (run_id, employee_id)
);

create table payslips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  line_id uuid not null unique references payroll_lines(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  period_month date not null,
  file_id uuid references files(id) on delete set null,
  released_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on payslips (employee_id, period_month desc);

create table payment_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null references payroll_runs(id) on delete restrict,
  bank_format text not null,           -- neft_generic, hdfc, icici, sbi, axis, kotak ...
  line_ids uuid[] not null,
  total_paise bigint not null,
  file_id uuid references files(id) on delete set null,
  status text not null default 'generated' check (status in ('generated','paid','failed','cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table tax_declarations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  fy_start date not null check (extract(month from fy_start) = 4 and extract(day from fy_start) = 1),
  regime text not null check (regime in ('old','new')),
  house_property jsonb not null default '{}',   -- rented [{rent_per_month, from, to, landlord, landlord_pan, metro}], owned [{interest, ...}]
  other_income jsonb not null default '{}',
  previous_employer jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted','approved','locked')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, fy_start)
);

create table tax_declaration_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  declaration_id uuid not null references tax_declarations(id) on delete cascade,
  section text not null,               -- 80C, 80D, 80CCD(1B), 80E, 24b, ...
  item text not null,
  declared_paise bigint not null check (declared_paise >= 0),
  accepted_paise bigint,
  proof_file_ids uuid[] not null default '{}',
  proof_status text not null default 'not_submitted' check (proof_status in ('not_submitted','submitted','accepted','partially_accepted','rejected')),
  reviewer_comment text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table fbp_declarations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  fy_start date not null,
  component_id uuid not null references salary_components(id) on delete restrict,
  annual_paise bigint not null check (annual_paise >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, fy_start, component_id)
);

create table component_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  component_id uuid not null references salary_components(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  bill_file_ids uuid[] not null default '{}',
  payout_month date,
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table form16_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  fy_start date not null,
  part_a_file_id uuid references files(id) on delete set null,
  part_b_file_id uuid references files(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, fy_start)
);

create table loan_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  max_amount_paise bigint, max_tenure_months int,
  interest_rate numeric(5,2) not null default 0,
  rate_type text not null default 'zero' check (rate_type in ('zero','flat','reducing')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table loans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete restrict,
  category_id uuid not null references loan_categories(id) on delete restrict,
  principal_paise bigint not null check (principal_paise > 0),
  currency char(3) not null default 'INR',
  interest_rate numeric(5,2) not null default 0,
  rate_type text not null check (rate_type in ('zero','flat','reducing')),
  tenure_months int not null check (tenure_months > 0),
  emi_paise bigint,
  disbursed_on date, first_emi_month date,
  reason text,
  status text not null default 'requested' check (status in ('requested','approved','rejected','disbursed','active','closed','written_off')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table loan_installments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  loan_id uuid not null references loans(id) on delete cascade,
  due_month date not null,
  principal_paise bigint not null, interest_paise bigint not null,
  status text not null default 'scheduled' check (status in ('scheduled','deducted','skipped','prepaid')),
  payroll_line_id uuid references payroll_lines(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (loan_id, due_month)
);

create table fnf_settlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  exit_request_id uuid not null unique references exit_requests(id) on delete restrict,
  employee_id uuid not null references employees(id) on delete restrict,
  mode text not null default 'one_time' check (mode in ('one_time','periodic')),
  settlement_month date,
  items jsonb not null default '[]',   -- [{category, component, amount_paise, action: pay|void|already_paid}]
  net_paise bigint,
  statement_file_id uuid references files(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','approved','finalized')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 13. Expenses
-- =========================================================================
create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  policy_id uuid not null references expense_policies(id) on delete cascade,
  name text not null,
  kind text not null default 'general' check (kind in ('general','mileage','travel','per_diem')),
  limit_paise bigint, limit_period text check (limit_period in ('claim','day','month','year')),
  rate_per_km_paise bigint,
  receipt_required_above_paise bigint,
  gl_code text,
  custom_fields jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (policy_id, name)
);

create table expense_advances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  amount_paise bigint not null check (amount_paise > 0),
  currency char(3) not null default 'INR',
  purpose text not null,
  settled_paise bigint not null default 0,
  receipts_due_on date,
  status text not null default 'pending' check (status in ('pending','approved','rejected','paid','settled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table expense_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number bigint not null,
  employee_id uuid not null references employees(id) on delete cascade,
  title text not null,
  advance_id uuid references expense_advances(id) on delete set null,
  total_paise bigint not null default 0,
  currency char(3) not null default 'INR',
  payout text not null default 'payroll' check (payout in ('payroll','off_cycle')),
  payout_month date,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','paid')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  claim_id uuid references expense_claims(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  category_id uuid not null references expense_categories(id) on delete restrict,
  spent_on date not null,
  amount_paise bigint not null check (amount_paise > 0),
  currency char(3) not null default 'INR',
  fx_rate numeric(14,6) not null default 1,
  base_amount_paise bigint not null,
  merchant text, description text,
  distance_km numeric(8,2),
  receipt_file_ids uuid[] not null default '{}',
  violations text[] not null default '{}',
  custom jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- =========================================================================
-- 14. PSA / timesheets
-- =========================================================================
create table clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, billing_address jsonb not null default '{}', gstin text,
  currency char(3) not null default 'INR',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  client_id uuid references clients(id) on delete restrict,
  name text not null, code text not null,
  billing_model text not null default 'non_billable' check (billing_model in ('time_and_materials','retainer','fixed','non_billable')),
  retainer_paise bigint, currency char(3) not null default 'INR',
  start_date date, end_date date,
  status text not null default 'active' check (status in ('active','on_hold','completed','archived')),
  approver_employee_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text, bill_rate_paise bigint, allocation_pct int check (allocation_pct between 0 and 100),
  primary key (project_id, employee_id)
);

create table project_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null, is_billable boolean not null default true,
  phase text, start_date date, end_date date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table timesheets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  total_minutes int not null default 0,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (employee_id, week_start)
);

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  timesheet_id uuid not null references timesheets(id) on delete cascade,
  project_id uuid not null references projects(id) on delete restrict,
  task_id uuid references project_tasks(id) on delete restrict,
  date date not null,
  minutes int not null check (minutes between 1 and 1440),
  is_billable boolean not null default true,
  note text,
  invoice_id uuid,                     -- fk added below
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table psa_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  client_id uuid not null references clients(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  number text not null,
  period daterange not null,
  lines jsonb not null,
  subtotal_paise bigint not null, tax_paise bigint not null default 0,
  currency char(3) not null default 'INR',
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
alter table time_entries add constraint time_entries_invoice_fk foreign key (invoice_id) references psa_invoices(id) on delete set null;

-- =========================================================================
-- 15. Hire (ATS) & preboarding
-- =========================================================================
create table hiring_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, description text, is_default boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table hiring_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  flow_id uuid not null references hiring_flows(id) on delete cascade,
  name text not null,
  stage_group text not null check (stage_group in ('sourced','screening','interview','offer','hired','rejected')),
  position int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (flow_id, position) deferrable initially deferred
);

create table rating_scales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  usage text not null default 'any' check (usage in ('hire','performance','any')),
  points jsonb not null,               -- [{"value":1,"label":"Poor"},...]
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table scorecards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  rating_scale_id uuid not null references rating_scales(id) on delete restrict,
  sections jsonb not null,             -- [{"title","criteria":[{"id","label"}]}]
  overall_rating boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table requisitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  openings int not null default 1 check (openings > 0),
  job_type text not null default 'full_time' check (job_type in ('full_time','part_time','contract','intern')),
  department_id uuid references departments(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  salary_min_paise bigint, salary_max_paise bigint, currency char(3) not null default 'INR',
  target_date date, description text, qualification text,
  experience_min int, experience_max int,
  backfill_for_employee_id uuid references employees(id) on delete set null,
  raised_by_employee_id uuid not null references employees(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','pending','sent_back','approved','rejected','converted','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table career_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug citext not null unique,
  title text not null, branding jsonb not null default '{}', about_html text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requisition_id uuid references requisitions(id) on delete set null,
  title text not null,
  department_id uuid references departments(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  description_html text not null default '',
  openings int not null default 1 check (openings > 0),
  target_date date,
  job_type text not null default 'full_time' check (job_type in ('full_time','part_time','contract','intern')),
  experience_min int, experience_max int,
  salary_min_paise bigint, salary_max_paise bigint, currency char(3) not null default 'INR', show_salary boolean not null default false,
  hiring_flow_id uuid not null references hiring_flows(id) on delete restrict,
  allow_reapply_after_days int,
  publish jsonb not null default '{"career_site":false,"internal":false,"referrals":false}',
  career_site_id uuid references career_sites(id) on delete set null,
  application_form jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','open','on_hold','closed')),
  published_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on jobs (tenant_id, status);

create table job_team_members (
  job_id uuid not null references jobs(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('recruiter','hiring_manager','panelist','coordinator')),
  primary key (job_id, employee_id, role)
);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  first_name text not null, last_name text,
  email citext not null, mobile text,
  gender text, current_company text, current_title text,
  experience_months int,
  source text not null default 'manual' check (source in ('manual','career_site','referral','internal','import','job_board','agency')),
  resume_file_id uuid references files(id) on delete set null,
  parsed jsonb not null default '{}',
  tags text[] not null default '{}',
  custom jsonb not null default '{}',
  employee_id uuid references employees(id) on delete set null,   -- internal applicant or converted hire
  consent_at timestamptz,              -- DPDP consent from career-site applicants
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create index on candidates using gin ((first_name || ' ' || coalesce(last_name,'')) gin_trgm_ops);
alter table generated_letters add constraint generated_letters_candidate_fk foreign key (candidate_id) references candidates(id) on delete cascade;

create table applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  stage_id uuid not null references hiring_stages(id) on delete restrict,
  owner_employee_id uuid references employees(id) on delete set null,
  referred_by_employee_id uuid references employees(id) on delete set null,
  status text not null default 'active' check (status in ('active','rejected','withdrawn','hired')),
  reject_reason text,
  stage_entered_at timestamptz not null default now(),
  answers jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);
create index on applications (job_id, stage_id) where status = 'active';

create table application_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  kind text not null,                  -- stage_change, email, note, interview, offer
  data jsonb not null default '{}',
  actor_employee_id uuid references employees(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table interviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  stage_id uuid references hiring_stages(id) on delete set null,
  mode text not null check (mode in ('online','in_person','phone')),
  scheduling text not null default 'fixed' check (scheduling in ('fixed','self_schedule')),
  starts_at timestamptz, ends_at timestamptz,
  slot_options tstzrange[],            -- offered slots for self-scheduling
  meeting_url text, location text,
  scorecard_id uuid references scorecards(id) on delete set null,
  status text not null default 'scheduled' check (status in ('awaiting_candidate','scheduled','completed','cancelled','no_show')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create table interview_panelists (
  interview_id uuid not null references interviews(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  primary key (interview_id, employee_id)
);

create table scorecard_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  interview_id uuid references interviews(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  scorecard_id uuid not null references scorecards(id) on delete restrict,
  interviewer_employee_id uuid not null references employees(id) on delete cascade,
  ratings jsonb not null,              -- {criterion_id: value}
  overall numeric(4,2),
  recommendation text check (recommendation in ('strong_yes','yes','no','strong_no')),
  comments text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (interview_id, interviewer_employee_id)
);

create table candidate_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  application_id uuid references applications(id) on delete cascade,
  author_employee_id uuid not null references employees(id) on delete cascade,
  body text not null, is_private boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  version int not null default 1,
  designation_id uuid references designations(id) on delete set null,
  ctc_paise bigint not null check (ctc_paise > 0), currency char(3) not null default 'INR',
  joining_date date not null,
  letter_id uuid references generated_letters(id) on delete set null,
  expires_on date,
  status text not null default 'draft' check (status in ('draft','pending_approval','released','accepted','declined','revised','withdrawn','expired')),
  responded_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (application_id, version)
);

create table candidate_portal_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table document_requests (           -- preboarding / onboarding document collection
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid references candidates(id) on delete cascade,
  employee_id uuid references employees(id) on delete cascade,
  doc_type text not null, required boolean not null default true,
  file_id uuid references files(id) on delete set null,
  status text not null default 'requested' check (status in ('requested','uploaded','approved','rejected')),
  reviewer_comment text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (candidate_id is not null or employee_id is not null)
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  referrer_employee_id uuid not null references employees(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  note text,
  bonus_status text not null default 'none' check (bonus_status in ('none','eligible','paid')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);

create table email_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  module text not null, key text not null,
  subject text not null, body_html text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, module, key)
);

-- =========================================================================
-- 16. Performance, feedback, 1:1, compensation
-- =========================================================================
create table performance_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, starts_on date not null, ends_on date not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name), check (ends_on > starts_on)
);

create table objectives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  period_id uuid references performance_periods(id) on delete set null,
  level text not null check (level in ('company','department','individual')),
  owner_employee_id uuid references employees(id) on delete cascade,
  department_id uuid references departments(id) on delete cascade,
  parent_id uuid references objectives(id) on delete set null,
  title text not null, description text,
  weight numeric(5,2) not null default 0 check (weight between 0 and 100),
  progress numeric(5,2) not null default 0 check (progress between 0 and 100),
  status text not null default 'not_started' check (status in ('not_started','on_track','at_risk','behind','completed','closed')),
  due_date date,
  visibility text not null default 'public' check (visibility in ('public','private')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);

create table key_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  objective_id uuid not null references objectives(id) on delete cascade,
  title text not null,
  metric text not null default 'percent' check (metric in ('percent','number','currency','boolean')),
  start_value numeric(14,2) not null default 0, target_value numeric(14,2) not null, current_value numeric(14,2) not null default 0,
  weight numeric(5,2) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table check_ins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  objective_id uuid references objectives(id) on delete cascade,
  key_result_id uuid references key_results(id) on delete cascade,
  author_employee_id uuid not null references employees(id) on delete cascade,
  value numeric(14,2), progress numeric(5,2),
  status text check (status in ('on_track','at_risk','behind','completed')),
  comment text, file_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (objective_id is not null or key_result_id is not null)
);

create table feedback_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('feedback','request','internal_note')),
  from_employee_id uuid not null references employees(id) on delete cascade,
  to_employee_id uuid not null references employees(id) on delete cascade,
  about_employee_id uuid references employees(id) on delete cascade,   -- for requests: feedback about whom
  body text,
  visibility text not null default 'private' check (visibility in ('private','manager','public')),
  status text not null default 'done' check (status in ('pending','done','declined')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table one_on_ones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  series_id uuid,                      -- recurring meetings share a series id
  organizer_employee_id uuid not null references employees(id) on delete cascade,
  attendee_employee_id uuid not null references employees(id) on delete cascade,
  starts_at timestamptz not null, ends_at timestamptz not null,
  recurrence text check (recurrence in ('weekly','biweekly','monthly')),
  purpose text,
  shared_notes text,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table one_on_one_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  meeting_id uuid not null references one_on_ones(id) on delete cascade,
  kind text not null check (kind in ('agenda','private_note','action_item')),
  author_employee_id uuid not null references employees(id) on delete cascade,
  body text not null,
  assignee_employee_id uuid references employees(id) on delete set null,
  due_date date, done_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table competencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('competency','core_value','skill')),
  name text not null, description text, levels jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, kind, name)
);

create table employee_skills (
  employee_id uuid not null references employees(id) on delete cascade,
  competency_id uuid not null references competencies(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  proficiency int not null check (proficiency between 1 and 5),
  primary key (employee_id, competency_id)
);

create table review_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  rating_scale_id uuid references rating_scales(id) on delete restrict,
  sections jsonb not null,             -- [{type: questions|goals|competencies|core_values|skills, title, items, weight}]
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table review_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  kind text not null default 'standard' check (kind in ('standard','aggregate','probation','new_joiner')),
  period_start date not null, period_end date not null,
  timelines jsonb not null,            -- {self_due, peer_due, manager_due, calibration_due, publish_on}
  reviewers jsonb not null,            -- {self:true, manager:true, peer:{min,max,nominated_by}, skip_level:false}
  form_id uuid not null references review_forms(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','live','calibration','published','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (period_end > period_start)
);

create table review_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  cycle_id uuid not null references review_cycles(id) on delete cascade,
  reviewee_employee_id uuid not null references employees(id) on delete cascade,
  reviewer_employee_id uuid not null references employees(id) on delete cascade,
  reviewer_type text not null check (reviewer_type in ('self','manager','peer','skip_level','direct_report')),
  answers jsonb not null default '{}',
  rating numeric(4,2),
  status text not null default 'not_started' check (status in ('not_started','draft','submitted','declined')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (cycle_id, reviewee_employee_id, reviewer_employee_id, reviewer_type)
);

create table review_outcomes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  cycle_id uuid not null references review_cycles(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  computed_rating numeric(4,2),
  final_rating numeric(4,2),
  potential int check (potential between 1 and 3),   -- 9-box axis
  calibrated_by uuid references users(id) on delete set null,
  calibration_note text,
  published_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (cycle_id, employee_id)
);

create table comp_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  review_cycle_id uuid references review_cycles(id) on delete set null,
  effective_from date not null,
  budget_paise bigint, currency char(3) not null default 'INR',
  matrix jsonb not null default '[]',  -- [{rating_min, rating_max, increment_pct_min, increment_pct_max}]
  status text not null default 'draft' check (status in ('draft','recommending','approving','approved','applied')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table comp_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  cycle_id uuid not null references comp_cycles(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  current_ctc_paise bigint not null,
  proposed_ctc_paise bigint not null,
  new_designation_id uuid references designations(id) on delete set null,
  recommended_by uuid references employees(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','applied')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (cycle_id, employee_id)
);

-- =========================================================================
-- 17. Learn
-- =========================================================================
create table courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null, description text, cover_file_id uuid references files(id) on delete set null,
  certificate boolean not null default true,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table course_modules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  kind text not null check (kind in ('video','document','text','quiz','link')),
  title text not null, content jsonb not null default '{}', file_id uuid references files(id) on delete set null,
  position int not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table course_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  rule jsonb not null,                 -- people / departments / locations / designations / new joiners
  due_in_days int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  assignment_id uuid references course_assignments(id) on delete set null,
  due_date date,
  progress jsonb not null default '{}',
  percent numeric(5,2) not null default 0,
  completed_at timestamptz,
  certificate_file_id uuid references files(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (course_id, employee_id)
);

-- =========================================================================
-- 18. Reports, API, integrations
-- =========================================================================
create table saved_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_user_id uuid references users(id) on delete set null,
  name text not null, dataset text not null,
  definition jsonb not null,           -- columns, filters, grouping, sort
  schedule jsonb,                      -- {cron, recipients}
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  key_prefix text not null, key_hash text not null unique,
  scopes text[] not null default '{}',
  last_used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  url text not null check (url ~ '^https://'),
  events text[] not null,
  secret_enc bytea not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event text not null, event_id uuid not null,
  payload jsonb not null,
  attempts int not null default 0, last_status int, next_attempt_at timestamptz, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (endpoint_id, event_id)
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('slack','teams','google_workspace','microsoft_365','tally','zoho_books','razorpayx','zkteco','essl')),
  config_enc bytea not null,
  status text not null default 'connected' check (status in ('connected','error','disconnected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);

-- =========================================================================
-- 19. Generic wiring: updated_at triggers, FK indexes, row level security
-- =========================================================================
do $$
declare r record;
begin
  -- updated_at trigger on every table that has the column
  for r in select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'updated_at'
             and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', r.table_name || '_updated_at', r.table_name);
  end loop;

  -- an index for every foreign key whose columns are not already the leading columns of some index
  for r in
    select c.conrelid::regclass as tbl, c.conname,
           array_agg(a.attname order by k.ord) as cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    group by c.conrelid, c.conname, c.conkey
    having not exists (
      select 1 from pg_index i
      where i.indrelid = c.conrelid
        and (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey
    )
  loop
    execute format('create index on %s (%s)', r.tbl, (select string_agg(quote_ident(x), ', ') from unnest(r.cols) x));
  end loop;

  -- RLS: every table with tenant_id is isolated per tenant
  for r in select table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'tenant_id'
             and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')
  loop
    execute format('alter table %I enable row level security', r.table_name);
    execute format('alter table %I force row level security', r.table_name);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', r.table_name);
  end loop;
end $$;

-- tenants: a tenant may read/update only its own row
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_self on tenants using (id = app_tenant()) with check (id = app_tenant());

-- Roles. erp_app = the web app (subject to RLS). erp_admin = migrations, platform console, cross-tenant jobs.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_app') then create role erp_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'erp_admin') then create role erp_admin nologin bypassrls; end if;
end $$;
grant usage on schema public to erp_app, erp_admin;
grant select, insert, update, delete on all tables in schema public to erp_app, erp_admin;
revoke insert, update, delete on statutory_rates, webhook_events from erp_app;
revoke update, delete on audit_logs, login_events, leave_ledger from erp_app;   -- append-only for the app
grant select on leave_balances to erp_app, erp_admin;
