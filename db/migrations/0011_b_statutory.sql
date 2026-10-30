-- Statutory rates: one version per kind/state/regime/start date, even when state or regime is empty
-- (the table's own unique constraint treats nulls as distinct, so it can't stop duplicates for PF/ESI/gratuity).
create unique index if not exists statutory_rates_version_idx
  on statutory_rates (kind, coalesce(state_code, ''), coalesce(regime, ''), effective_from);

-- A company's record that a chartered accountant checked erp's statutory rates. Append-only history; the latest row
-- counts only while the rates it was recorded against (rates_fingerprint) are still the rates in statutory_rates.
create table if not exists statutory_verifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  verified_by_name text not null check (length(btrim(verified_by_name)) between 2 and 200),   -- the CA or firm
  verified_on date not null,                                                                   -- when they signed off
  note text not null check (length(btrim(note)) between 5 and 2000),
  rates_fingerprint text not null,
  rates_count int not null check (rates_count > 0),
  recorded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists statutory_verifications_tenant_idx on statutory_verifications (tenant_id, created_at desc);
-- the same rates can be recorded once per company (a double submit is a no-op, not a second row)
create unique index if not exists statutory_verifications_once_idx on statutory_verifications (tenant_id, rates_fingerprint);

alter table statutory_verifications enable row level security;
alter table statutory_verifications force row level security;
drop policy if exists tenant_isolation on statutory_verifications;
create policy tenant_isolation on statutory_verifications using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert on statutory_verifications to erp_app;
grant select, insert, update, delete on statutory_verifications to erp_admin;
revoke update, delete on statutory_verifications from erp_app;   -- append-only for the app
