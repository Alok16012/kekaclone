-- hp2: AI-assisted hiring and helpdesk (advisory only), candidate privacy (erasure requests + retention),
-- interview reminders, and offer-letter signing from the joiner portal.

-- company-wide hiring privacy and AI switches (one row per company, created on first save)
create table hire_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  ai_enabled boolean not null default true,              -- use the external AI provider when it is configured
  candidate_retention_months int check (candidate_retention_months between 6 and 120),   -- null: keep until someone asks
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table helpdesk_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  ai_enabled boolean not null default true,
  suggest_before_raise boolean not null default true,     -- show policy answers while someone writes a ticket
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- advisory match score of an application against its job description (never used to reject anyone automatically)
create table resume_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  score int not null check (score between 0 and 100),
  method text not null check (method in ('ai','keywords')),
  model text,
  summary text not null default '',
  strengths jsonb not null default '[]',
  gaps jsonb not null default '[]',
  matched text[] not null default '{}',
  missing text[] not null default '{}',
  jd_hash text not null,
  scored_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (application_id)
);
create index on resume_scores (tenant_id);
create index on resume_scores (scored_by);

-- candidate data-erasure requests (DPDP / GDPR): from the candidate portal or logged by HR
alter table candidates add column anonymised_at timestamptz;
create table candidate_privacy_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid references candidates(id) on delete set null,
  source text not null check (source in ('portal','hr','retention')),
  status text not null default 'pending' check (status in ('pending','completed','declined')),
  reason text,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on candidate_privacy_requests (tenant_id, status);
create index on candidate_privacy_requests (candidate_id);
create index on candidate_privacy_requests (decided_by);
create unique index candidate_privacy_requests_one_pending on candidate_privacy_requests (candidate_id) where status = 'pending';

-- interview reminders go out once
alter table interviews add column reminder_sent_at timestamptz;

-- policy text for the helpdesk assistant (extracted lazily from the stored file and cached)
alter table org_documents add column text_content text, add column text_extracted_at timestamptz;

-- what the helpdesk assistant suggested, and whether it helped (feeds the "answered without a ticket" count)
create table helpdesk_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  ticket_id uuid references tickets(id) on delete cascade,
  kind text not null check (kind in ('self_service','agent_draft')),
  question text not null,
  method text not null check (method in ('ai','search')),
  document_ids uuid[] not null default '{}',
  helpful boolean,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on helpdesk_suggestions (tenant_id, created_at desc);
create index on helpdesk_suggestions (employee_id);
create index on helpdesk_suggestions (ticket_id);

-- joiner-portal signing of an issued offer letter (typed name + emailed code)
alter table generated_letters
  add column sign_otp_hash text,
  add column sign_otp_expires_at timestamptz,
  add column sign_otp_attempts int not null default 0,
  add column signed_name text,
  add column signed_at timestamptz,
  add column signed_ip text;

do $$
declare t text;
begin
  foreach t in array array['hire_settings','helpdesk_settings','resume_scores','candidate_privacy_requests','helpdesk_suggestions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
    execute format('grant select, insert, update, delete on %I to erp_app, erp_admin', t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;
