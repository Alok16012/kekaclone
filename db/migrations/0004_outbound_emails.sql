-- Every email erp sends: delivery log, retry source, and the local dev mailbox.
create table outbound_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,                         -- invite, reset_password, login_code, ...
  to_email citext not null,
  subject text not null,
  html text not null,
  text_body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  provider text,                              -- dev | resend
  provider_id text,
  error text,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on outbound_emails (tenant_id, created_at desc);
create index on outbound_emails (tenant_id) where status = 'queued';
create trigger outbound_emails_updated_at before update on outbound_emails for each row execute function set_updated_at();
alter table outbound_emails enable row level security;
alter table outbound_emails force row level security;
create policy tenant_isolation on outbound_emails using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on outbound_emails to erp_app;
grant select, insert, update, delete on outbound_emails to erp_admin;

-- who invited whom and when (shown as "Invited 2 days ago" / "Resend invite")
alter table users add column invited_at timestamptz;
