-- performance + compensation. Most tables exist since 0001 (performance_periods, objectives, key_results, check_ins,
-- feedback_items, one_on_ones, one_on_one_items, competencies, employee_skills, review_forms, review_cycles,
-- review_assignments, review_outcomes, comp_cycles, comp_proposals, rating_scales). This adds what was missing:
-- company settings, PIPs, peer nominations, cycle targeting/automation, nudges, calibration bands and comp proposal detail.

-- one row per tenant: OKR or KRA wording, default rating scale, bands, rounding, reviewer weights, ideal curve, reminders
create table performance_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  goal_mode text not null default 'okr' check (goal_mode in ('okr','kra')),
  rating_scale_id uuid references rating_scales(id) on delete set null,
  bands jsonb not null default '[]',                 -- [{min, max, label}] on the rating scale
  ideal_distribution jsonb not null default '[]',    -- [{label, pct}] per band, adds up to 100
  rounding text not null default 'one_decimal' check (rounding in ('none','one_decimal','half','whole')),
  reviewer_weights jsonb not null default '{"self":0,"manager":100,"peer":0,"skip_level":0}',
  checkin_reminder text not null default 'weekly' check (checkin_reminder in ('off','weekly','biweekly','monthly')),
  kr_weights_must_total boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- goals: who created them and an ordering hint; check-ins keep the objective's progress at that moment
alter table objectives add column created_by uuid references users(id) on delete set null;
alter table objectives add column closed_at timestamptz;
create index on objectives (tenant_id, level, owner_employee_id);
create index on objectives (parent_id);
create index on check_ins (objective_id, created_at desc);
create index on check_ins (key_result_id, created_at desc);

-- feedback: a response points at the request it answers
alter table feedback_items add column request_id uuid references feedback_items(id) on delete set null;
alter table feedback_items add column responded_at timestamptz;
create index on feedback_items (request_id);
create index on feedback_items (tenant_id, to_employee_id, created_at desc);
create index on feedback_items (tenant_id, from_employee_id, created_at desc);
create index on feedback_items (tenant_id, about_employee_id, created_at desc);

-- 1:1s: action items moved forward to the next meeting keep where they came from
alter table one_on_one_items add column carried_from_meeting_id uuid references one_on_ones(id) on delete set null;
create index on one_on_one_items (carried_from_meeting_id);
create index on one_on_ones (series_id, starts_at);
create index on one_on_ones (organizer_employee_id, starts_at);
create index on one_on_ones (attendee_employee_id, starts_at);

-- review cycles: who is in it, automation rules (probation / new joiners), aggregates of earlier cycles, lifecycle stamps
alter table review_cycles alter column form_id drop not null;
alter table review_cycles add column employee_filter jsonb not null default '{}';   -- {department_ids, location_ids, joined_before, include_ids, exclude_ids}
alter table review_cycles add column auto_rule jsonb;                               -- {trigger: 'joining'|'probation_end', days}
alter table review_cycles add column source_cycle_ids uuid[] not null default '{}';  -- aggregate cycles
alter table review_cycles add column launched_at timestamptz;
alter table review_cycles add column published_at timestamptz;
alter table review_cycles add column created_by uuid references users(id) on delete set null;
alter table review_cycles add constraint review_cycles_form_check check (kind = 'aggregate' or form_id is not null);
alter table review_cycles add constraint review_cycles_name_unique unique (tenant_id, name);

-- peer nominations: proposed by the reviewee (or manager), approved by the manager before the peer is asked
alter table review_assignments add column nomination text check (nomination in ('proposed','approved','rejected'));
alter table review_assignments add column nominated_by uuid references employees(id) on delete set null;
alter table review_assignments add column nudged_at timestamptz;
create index on review_assignments (tenant_id, reviewer_employee_id, status);
create index on review_assignments (cycle_id, reviewee_employee_id);

alter table review_outcomes add column band text;
alter table review_outcomes add column released boolean not null default false;   -- shown to the employee

-- compensation: the rating and % behind a proposal, the note, and the salary revision it became
alter table comp_cycles add column created_by uuid references users(id) on delete set null;
alter table comp_cycles add column applied_at timestamptz;
alter table comp_cycles add constraint comp_cycles_budget_check check (budget_paise is null or budget_paise >= 0);
alter table comp_cycles add constraint comp_cycles_name_unique unique (tenant_id, name);
alter table comp_proposals add column rating numeric(4,2);
alter table comp_proposals add column increment_bp int not null default 0 check (increment_bp between 0 and 10000);   -- basis points (1250 = 12.5%)
alter table comp_proposals add column note text;
alter table comp_proposals add column salary_id uuid references employee_salaries(id) on delete set null;
alter table comp_proposals add column arrears_from_month date;
alter table comp_proposals add column applied_at timestamptz;
alter table comp_proposals add column apply_error text;
alter table comp_proposals add constraint comp_proposals_amounts_check check (current_ctc_paise > 0 and proposed_ctc_paise >= current_ctc_paise);
create index on comp_proposals (salary_id);
create index on comp_proposals (recommended_by);

-- PIP: a plan with goals and a timeline, regular check-ins, and an outcome
create table pips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  owner_employee_id uuid references employees(id) on delete set null,   -- usually the manager who runs it
  created_by uuid references users(id) on delete set null,
  reason text not null,
  goals jsonb not null default '[]',      -- [{id, title, measure, met: null|true|false}]
  starts_on date not null, ends_on date not null,
  status text not null default 'active' check (status in ('active','extended','passed','failed','cancelled')),
  outcome_note text,
  closed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_on > starts_on)
);
create index on pips (tenant_id, employee_id);
create index on pips (owner_employee_id);
create index on pips (created_by);
create unique index pips_one_open on pips (employee_id) where status in ('active','extended');

create table pip_check_ins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pip_id uuid not null references pips(id) on delete cascade,
  author_employee_id uuid not null references employees(id) on delete cascade,
  status text not null check (status in ('on_track','at_risk','off_track')),
  note text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on pip_check_ins (pip_id, created_at desc);
create index on pip_check_ins (tenant_id);
create index on pip_check_ins (author_employee_id);

-- RLS + updated_at for the new tables
do $$ declare t text; begin
  foreach t in array array['performance_settings','pips','pip_check_ins'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;
grant select, insert, update, delete on performance_settings, pips, pip_check_ins to erp_app, erp_admin;
