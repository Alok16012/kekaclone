-- Platform + integrations (plat2): workflow automations, editable email templates, OAuth2 clients, Zapier-style
-- REST hooks, per-user calendar connections and synced events, Web Push subscriptions, offline punch idempotency,
-- per-user language.

-- ---------------------------------------------------------------- automations (Settings → Automations)
create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  trigger text not null,
  trigger_config jsonb not null default '{}',   -- date triggers: { field, offset_days }
  conditions jsonb not null default '[]',       -- [{ field, op, value }]
  actions jsonb not null default '[]',          -- [{ type, ... }]
  is_active boolean not null default true,
  run_count int not null default 0,
  last_run_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists automations_tenant_trigger_idx on automations (tenant_id, trigger) where is_active;
alter table automations enable row level security;
alter table automations force row level security;
create policy tenant_isolation on automations using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger automations_updated_at before update on automations for each row execute function set_updated_at();
grant select, insert, update, delete on automations to erp_app, erp_admin;

create table if not exists automation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  trigger text not null,
  subject_employee_id uuid references employees(id) on delete set null,
  dedupe_key text not null,                     -- one run per automation per event occurrence
  status text not null check (status in ('ok','failed','skipped')),
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (automation_id, dedupe_key)
);
create index if not exists automation_runs_tenant_created_idx on automation_runs (tenant_id, created_at desc);
alter table automation_runs enable row level security;
alter table automation_runs force row level security;
create policy tenant_isolation on automation_runs using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update, delete on automation_runs to erp_app, erp_admin;

-- ---------------------------------------------------------------- notification email templates (Settings → Notifications → Templates)
create table if not exists notification_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  event text not null,
  subject text not null,
  body text not null,                           -- plain text with {{placeholders}}; one paragraph per blank line
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, event)
);
alter table notification_templates enable row level security;
alter table notification_templates force row level security;
create policy tenant_isolation on notification_templates using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger notification_templates_updated_at before update on notification_templates for each row execute function set_updated_at();
grant select, insert, update, delete on notification_templates to erp_app, erp_admin;

-- ---------------------------------------------------------------- OAuth2 clients (client credentials → short-lived JWT)
create table if not exists oauth_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  client_id text not null unique,
  secret_hash text not null,
  scopes text[] not null default '{}',
  last_used_at timestamptz, revoked_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table oauth_clients enable row level security;
alter table oauth_clients force row level security;
create policy tenant_isolation on oauth_clients using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger oauth_clients_updated_at before update on oauth_clients for each row execute function set_updated_at();
grant select, insert, update, delete on oauth_clients to erp_app, erp_admin;

-- ---------------------------------------------------------------- Zapier-style REST hooks reuse webhook endpoints
alter table webhook_endpoints add column if not exists kind text not null default 'manual' check (kind in ('manual','rest_hook','automation'));
alter table webhook_endpoints add column if not exists owner_ref text;    -- rest_hook: the api key / oauth client that subscribed
alter table webhook_endpoints add column if not exists label text;
create index if not exists webhook_endpoints_tenant_kind_idx on webhook_endpoints (tenant_id, kind);

-- ---------------------------------------------------------------- calendar connections (per person) and synced events
create table if not exists calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  account_email text,
  tokens_enc bytea not null,                    -- { access_token, refresh_token, expires_at }
  status text not null default 'connected' check (status in ('connected','error','disconnected')),
  last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
alter table calendar_connections enable row level security;
alter table calendar_connections force row level security;
create policy tenant_isolation on calendar_connections using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger calendar_connections_updated_at before update on calendar_connections for each row execute function set_updated_at();
grant select, insert, update, delete on calendar_connections to erp_app, erp_admin;

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null references calendar_connections(id) on delete cascade,
  kind text not null check (kind in ('interview','one_on_one','leave')),
  entity_id uuid not null,
  payload jsonb not null,                       -- { title, start, end, description, location }
  external_id text,
  status text not null default 'pending' check (status in ('pending','synced','cancelled','failed')),
  attempts int not null default 0, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (connection_id, kind, entity_id)
);
create index if not exists calendar_events_pending_idx on calendar_events (tenant_id, status) where status = 'pending';
alter table calendar_events enable row level security;
alter table calendar_events force row level security;
create policy tenant_isolation on calendar_events using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger calendar_events_updated_at before update on calendar_events for each row execute function set_updated_at();
grant select, insert, update, delete on calendar_events to erp_app, erp_admin;

-- ---------------------------------------------------------------- Web Push
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,                          -- { p256dh, auth }
  user_agent text,
  failures int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy tenant_isolation on push_subscriptions using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger push_subscriptions_updated_at before update on push_subscriptions for each row execute function set_updated_at();
grant select, insert, update, delete on push_subscriptions to erp_app, erp_admin;

create table if not exists push_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  payload jsonb not null,                       -- { title, body, url }
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts int not null default 0, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists push_outbox_queued_idx on push_outbox (tenant_id, created_at) where status = 'queued';
alter table push_outbox enable row level security;
alter table push_outbox force row level security;
create policy tenant_isolation on push_outbox using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create trigger push_outbox_updated_at before update on push_outbox for each row execute function set_updated_at();
grant select, insert, update, delete on push_outbox to erp_app, erp_admin;

-- ---------------------------------------------------------------- offline clock-in: a client id makes a queued punch safe to resend
alter table punches add column if not exists client_id text;
create unique index if not exists punches_employee_client_idx on punches (employee_id, client_id) where client_id is not null;

-- ---------------------------------------------------------------- per-user language
alter table users add column if not exists locale text not null default 'en' check (locale in ('en','hi'));
