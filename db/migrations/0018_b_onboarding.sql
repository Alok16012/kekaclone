-- Onboarding + surveys (build/onboarding).
-- Joiner portal: a one-time-shown link per onboarding process. Only a SHA-256 hash of the token is stored;
-- the public /join/<token> route resolves the tenant from the subdomain first, then looks the hash up under RLS.
alter table lifecycle_processes add column if not exists portal_token_hash text;
alter table lifecycle_processes add column if not exists portal_expires_at timestamptz;
create unique index if not exists lifecycle_processes_portal_token_hash_idx on lifecycle_processes (portal_token_hash) where portal_token_hash is not null;

-- surveys: quick lookup of a person's answered rounds, and of live surveys
create index if not exists surveys_tenant_status_idx on surveys (tenant_id, status);

-- existing companies: HR admins run onboarding and surveys (new companies get this from provisioning)
update roles set permissions = array(select distinct unnest(permissions || array['onboarding.manage', 'surveys.manage']))
 where key = 'hr_admin' and is_system and not (permissions @> array['onboarding.manage', 'surveys.manage']);
