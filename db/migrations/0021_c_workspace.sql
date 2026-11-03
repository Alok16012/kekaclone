-- workspace: PSA / timesheets, Learn and Reports. The core tables exist in 0001 (clients, projects, project_members,
-- project_tasks, timesheets, time_entries, psa_invoices, courses, course_modules, course_assignments, enrollments,
-- saved_reports). This adds what the screens need on top.

-- ---------- PSA ----------
create table timesheet_policies (          -- one row per company
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  cadence text not null default 'weekly' check (cadence in ('weekly','daily')),
  min_minutes_per_day int not null default 0 check (min_minutes_per_day between 0 and 1440),
  min_minutes_per_week int not null default 0 check (min_minutes_per_week between 0 and 10080),
  max_minutes_per_day int not null default 720 check (max_minutes_per_day between 60 and 1440),
  lock_after_days int check (lock_after_days is null or lock_after_days between 0 and 365),
  approver text not null default 'project' check (approver in ('project','manager')),
  allow_future boolean not null default false,
  require_note boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

alter table projects add column description text;
alter table projects add column budget_minutes int check (budget_minutes is null or budget_minutes >= 0);
alter table projects add column created_by uuid references users(id) on delete set null;
create index on projects (tenant_id, status);

create table project_milestones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  phase text,
  due_date date,
  amount_paise bigint not null default 0 check (amount_paise >= 0),
  status text not null default 'planned' check (status in ('planned','done')),
  done_at date,
  invoice_id uuid references psa_invoices(id) on delete set null,
  position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on project_milestones (project_id, position);

alter table timesheets add column submitted_at timestamptz;
alter table timesheets add column decided_at timestamptz;
alter table timesheets add column decision_comment text;
alter table timesheets add column billable_minutes int not null default 0;
create index on timesheets (tenant_id, status, week_start);

create index on time_entries (timesheet_id, date);
create index on time_entries (project_id, date);
create index on time_entries (invoice_id);

alter table psa_invoices add column issued_on date;
alter table psa_invoices add column due_on date;
alter table psa_invoices add column paid_on date;
alter table psa_invoices add column tax_rate_bp int not null default 1800 check (tax_rate_bp between 0 and 10000);
alter table psa_invoices add column notes text;
alter table psa_invoices add column created_by uuid references users(id) on delete set null;
create index on psa_invoices (tenant_id, status, created_at desc);

-- ---------- Learn ----------
alter table courses add column created_by uuid references users(id) on delete set null;
alter table courses add column published_at timestamptz;
alter table courses add column estimated_minutes int check (estimated_minutes is null or estimated_minutes >= 0);
create index on courses (tenant_id, status);
create index on course_modules (course_id, position);

alter table course_assignments add column name text not null default 'Assignment';
alter table course_assignments add column reminder_days_before int check (reminder_days_before is null or reminder_days_before between 0 and 90);
alter table course_assignments add column is_active boolean not null default true;
alter table course_assignments add column created_by uuid references users(id) on delete set null;

alter table enrollments add column certificate_code text;
alter table enrollments add column reminded_on date;
alter table enrollments add column last_activity_at timestamptz;
create unique index enrollments_certificate_code on enrollments (certificate_code) where certificate_code is not null;
create index on enrollments (employee_id, completed_at);
create index on enrollments (course_id, completed_at);

create table quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  module_id uuid not null references course_modules(id) on delete cascade,
  answers jsonb not null default '[]',
  score int not null, total int not null,
  passed boolean not null,
  created_at timestamptz not null default now()
);
create index on quiz_attempts (enrollment_id, module_id, created_at desc);

-- ---------- Reports ----------
alter table saved_reports add column shared_roles text[] not null default '{}';
alter table saved_reports add column kind text not null default 'custom' check (kind in ('custom','standard'));
alter table saved_reports add column next_run_at timestamptz;
alter table saved_reports add column last_run_at timestamptz;
create index on saved_reports (tenant_id, next_run_at) where next_run_at is not null;
create index on saved_reports (owner_user_id);

create table report_deliveries (           -- a scheduled run: the file and who may open it
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  saved_report_id uuid not null references saved_reports(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  recipient_employee_ids uuid[] not null default '{}',
  row_count int not null default 0,
  created_at timestamptz not null default now()
);
create index on report_deliveries (saved_report_id, created_at desc);

-- RLS + grants for the new tables (0001 only covered the tables that existed then)
do $$
declare r record;
begin
  for r in select unnest(array['timesheet_policies','project_milestones','quiz_attempts','report_deliveries']) as table_name loop
    execute format('alter table %I enable row level security', r.table_name);
    execute format('alter table %I force row level security', r.table_name);
    execute format('drop policy if exists tenant_isolation on %I', r.table_name);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', r.table_name);
    execute format('grant select, insert, update, delete on %I to erp_app, erp_admin', r.table_name);
  end loop;
end $$;
