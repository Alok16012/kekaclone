-- Core HR + approvals settings + daily scheduler: only what the target schema didn't record yet.

-- Approval workflows: escalation when a step waits too long ({"afterDays": 3, "to": {"approver": "role", "role": "hr_admin"}}).
alter table approval_workflows add column if not exists escalation jsonb;

-- Steps: escalated once, reassigned from someone (delegation / relieved approver), decided by the timer.
alter table approval_steps add column if not exists escalated_at timestamptz;
alter table approval_steps add column if not exists delegated_from uuid references employees(id) on delete set null;
alter table approval_steps add column if not exists auto_decided boolean not null default false;
create index if not exists approval_steps_delegated_from_idx on approval_steps (delegated_from);
create index if not exists approval_steps_request_level_idx on approval_steps (request_id, level);

-- "While I'm away, send my approvals to …" (set by the person or by HR). Open-ended when to_date is null.
create table if not exists approval_delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  delegator_employee_id uuid not null references employees(id) on delete cascade,
  delegate_employee_id uuid not null references employees(id) on delete cascade,
  from_date date not null,
  to_date date,
  reason text,
  created_by uuid references users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (delegator_employee_id <> delegate_employee_id),
  check (to_date is null or to_date >= from_date)
);
create index if not exists approval_delegations_delegator_idx on approval_delegations (tenant_id, delegator_employee_id, from_date);
create index if not exists approval_delegations_delegate_idx on approval_delegations (delegate_employee_id);
create index if not exists approval_delegations_created_by_idx on approval_delegations (created_by);
alter table approval_delegations enable row level security;
alter table approval_delegations force row level security;
drop policy if exists tenant_isolation on approval_delegations;
create policy tenant_isolation on approval_delegations using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
drop trigger if exists approval_delegations_updated_at on approval_delegations;
create trigger approval_delegations_updated_at before update on approval_delegations for each row execute function set_updated_at();

-- Rehire as a new employment record keeps a link to the earlier one.
alter table employees add column if not exists rehired_from_employee_id uuid references employees(id) on delete set null;
create index if not exists employees_rehired_from_idx on employees (rehired_from_employee_id);

-- Identity documents: who verified them.
alter table employee_identities add column if not exists verified_by uuid references users(id) on delete set null;
create index if not exists employee_identities_verified_by_idx on employee_identities (verified_by);

-- Group membership lookups by group.
create index if not exists employee_groups_group_idx on employee_groups (group_id);

-- One row per tenant, job and day from `pnpm jobs:daily` (idempotency + the admin "Scheduled jobs" view).
create table if not exists scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job text not null,
  run_date date not null,
  status text not null check (status in ('ok','failed')),
  result jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, job, run_date)
);
alter table scheduler_runs enable row level security;
alter table scheduler_runs force row level security;
drop policy if exists tenant_isolation on scheduler_runs;
create policy tenant_isolation on scheduler_runs using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
drop trigger if exists scheduler_runs_updated_at on scheduler_runs;
create trigger scheduler_runs_updated_at before update on scheduler_runs for each row execute function set_updated_at();
