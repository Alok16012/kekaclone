-- hire: ATS + preboarding. Most tables already exist in 0001 (hiring_flows, hiring_stages, rating_scales, scorecards,
-- requisitions, career_sites, jobs, job_team_members, candidates, applications, application_events, interviews,
-- interview_panelists, scorecard_submissions, candidate_notes, offers, document_requests, referrals, email_templates).
-- This adds only what was missing.

-- offers: the letter it was made from, the merged text, who made it, release and the candidate's signature (typed name + emailed code)
alter table offers
  add column template_id uuid references letter_templates(id) on delete set null,
  add column note text,
  add column created_by uuid references users(id) on delete set null,
  add column released_at timestamptz,
  add column signed_name text,
  add column signed_at timestamptz,
  add column signed_ip text,
  add column decline_reason text,
  add column otp_hash text,
  add column otp_expires_at timestamptz,
  add column otp_attempts int not null default 0;
create index on offers (template_id);
create index on offers (created_by);
create index on offers (tenant_id, status);
-- one live offer per application (older versions are 'revised' / 'withdrawn' / 'declined' / 'expired')
create unique index offers_one_live on offers (application_id) where status in ('draft','pending_approval','released','accepted');

-- automation: email the candidate a template when they enter a stage
alter table hiring_stages add column on_enter_email_key text;

-- where an application came from (a person can be referred for one job and apply to another), when it ended
alter table applications
  add column source text not null default 'manual' check (source in ('manual','career_site','referral','internal','import','job_board','agency')),
  add column hired_at timestamptz,
  add column closed_at timestamptz;
create index on applications (tenant_id, status);
create index on applications (candidate_id);

alter table interviews
  add column title text,
  add column notes text,
  add column created_by uuid references users(id) on delete set null;
create index on interviews (created_by);
create index on interviews (tenant_id, starts_at);

alter table jobs
  add column created_by uuid references users(id) on delete set null,
  add column closed_at timestamptz;
create index on jobs (created_by);

-- links sent to people outside the app: candidate portal, self-scheduling, an interviewer's scorecard
create table hire_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('portal','self_schedule','scorecard')),
  token_hash text not null unique,
  candidate_id uuid references candidates(id) on delete cascade,
  interview_id uuid references interviews(id) on delete cascade,
  employee_id uuid references employees(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (kind <> 'portal' or candidate_id is not null),
  check (kind <> 'self_schedule' or interview_id is not null),
  check (kind <> 'scorecard' or (interview_id is not null and employee_id is not null))
);
create index on hire_tokens (tenant_id);
create index on hire_tokens (candidate_id);
create index on hire_tokens (interview_id);
create index on hire_tokens (employee_id);

create table jd_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description_html text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- preboarding to-dos for a joiner (ticked off in the candidate portal)
create table preboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  title text not null,
  description text,
  done_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on preboarding_tasks (tenant_id);
create index on preboarding_tasks (candidate_id);

-- fixed-window counters for public endpoints (careers apply, portal codes)
create table hire_rate_limits (
  tenant_id uuid not null references tenants(id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (tenant_id, bucket, window_start)
);

create index on document_requests (candidate_id);
create index on referrals (referrer_employee_id);
create index on candidates (tenant_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['hire_tokens','jd_templates','preboarding_tasks','hire_rate_limits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
    execute format('grant select, insert, update, delete on %I to erp_app, erp_admin', t);
  end loop;
end $$;
