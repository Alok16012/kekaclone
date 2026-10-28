-- Login role for the web app (member of erp_app, subject to RLS) and a pre-auth tenant lookup.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_app_user') then
    create role erp_app_user login password 'erp_app_dev_only' in role erp_app;   -- dev password; production uses a secret
  end if;
end $$;
grant usage, select on all sequences in schema public to erp_app;
alter default privileges in schema public grant select, insert, update, delete on tables to erp_app;

-- Before login we only know the subdomain. This is the one cross-tenant read the app may do, and it returns public fields only.
create or replace function tenant_by_subdomain(p_subdomain text)
returns table (id uuid, name text, status text, auth_settings jsonb, branding jsonb)
language sql stable security definer set search_path = public as
$$ select t.id, t.name, t.status, t.auth_settings, t.branding from tenants t where t.subdomain = p_subdomain::citext $$;
revoke all on function tenant_by_subdomain(text) from public;
grant execute on function tenant_by_subdomain(text) to erp_app;

-- Signup needs to know a subdomain is free without seeing other tenants.
create or replace function subdomain_available(p_subdomain text) returns boolean
language sql stable security definer set search_path = public as
$$ select not exists (select 1 from tenants where subdomain = p_subdomain::citext) $$;
revoke all on function subdomain_available(text) from public;
grant execute on function subdomain_available(text) to erp_app;

-- Atomic per-tenant counters (ticket no, claim no ...).
create or replace function next_counter(p_key text) returns bigint language sql as
$$ insert into counters (tenant_id, key, value) values (app_tenant(), p_key, 1)
   on conflict (tenant_id, key) do update set value = counters.value + 1
   returning value $$;
