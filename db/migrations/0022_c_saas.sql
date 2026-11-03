-- SaaS platform: billing details on tenants, a dev SMS log, inbound webhook writes for the app role,
-- plan/trial in the public tenant lookup, delivery errors on outbound webhooks.

alter table tenants add column if not exists billing jsonb not null default '{}';

-- outbound SMS (mobile OTP). Without MSG91 keys the message is only recorded and shows in /dev/sms.
create table if not exists outbound_sms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,
  to_phone text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  provider text, provider_id text, error text,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists outbound_sms_tenant_created_idx on outbound_sms (tenant_id, created_at desc);
create trigger outbound_sms_updated_at before update on outbound_sms for each row execute function set_updated_at();
alter table outbound_sms enable row level security;
alter table outbound_sms force row level security;
create policy tenant_isolation on outbound_sms using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update, delete on outbound_sms to erp_app, erp_admin;

-- the billing webhook endpoint records provider events (idempotent by provider + event id)
grant insert, update on webhook_events to erp_app;

alter table webhook_deliveries add column if not exists last_error text;
alter table api_keys add column if not exists created_by uuid references users(id) on delete set null;

-- the public tenant lookup also tells the plan and trial end, so the login page and plan gates work before sign-in
drop function if exists tenant_by_subdomain(text);
create or replace function tenant_by_subdomain(p_subdomain text)
returns table (id uuid, name text, status text, auth_settings jsonb, branding jsonb, plan text, trial_ends_at timestamptz, seats int)
language sql stable security definer set search_path = public as
$$ select t.id, t.name, t.status, t.auth_settings, t.branding, t.plan, t.trial_ends_at, t.seats from tenants t where t.subdomain = p_subdomain::citext $$;
revoke all on function tenant_by_subdomain(text) from public;
grant execute on function tenant_by_subdomain(text) to erp_app;
