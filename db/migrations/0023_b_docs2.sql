-- docs2: bulk letters, erp Sign (e-sign with OTP), document review + expiry reminders, editable exit checklist with
-- auto-ticks, exit survey, sign-up email verification, login background image, system roles for existing companies.

-- ---------- documents: HR review + expiry reminders ----------
alter table employee_documents add column if not exists review_comment text;
alter table employee_documents add column if not exists expiry_reminders jsonb not null default '{}';   -- {"30": iso, "7": iso}
create index if not exists employee_documents_employee_idx on employee_documents (employee_id);
create index if not exists employee_documents_file_idx on employee_documents (file_id);
alter table employee_identities add column if not exists expiry_reminders jsonb not null default '{}';

-- ---------- bulk letter generation ----------
create table if not exists letter_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid references letter_templates(id) on delete set null,
  template_name text not null,
  filters jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  zip_file_id uuid references files(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  error text,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists letter_batches_tenant_idx on letter_batches (tenant_id, created_at desc);
create index if not exists letter_batches_template_idx on letter_batches (template_id);
create index if not exists letter_batches_zip_idx on letter_batches (zip_file_id);
create index if not exists letter_batches_created_by_idx on letter_batches (created_by);

create table if not exists letter_batch_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  batch_id uuid not null references letter_batches(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','done','failed')),
  letter_id uuid references generated_letters(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (batch_id, employee_id)
);
create index if not exists letter_batch_items_batch_status_idx on letter_batch_items (batch_id, status);
create index if not exists letter_batch_items_employee_idx on letter_batch_items (employee_id);
create index if not exists letter_batch_items_letter_idx on letter_batch_items (letter_id);
create index if not exists letter_batch_items_file_idx on letter_batch_items (file_id);

-- ---------- erp Sign ----------
alter table signature_requests add column if not exists token_hash text;
alter table signature_requests add column if not exists signer_name text;
alter table signature_requests add column if not exists title text;             -- e.g. "HR Manager", printed under the signature
alter table signature_requests add column if not exists otp_hash text;
alter table signature_requests add column if not exists otp_expires_at timestamptz;
alter table signature_requests add column if not exists otp_attempts int not null default 0;
alter table signature_requests add column if not exists signature_type text check (signature_type in ('typed','drawn'));
alter table signature_requests add column if not exists typed_name text;
alter table signature_requests add column if not exists document_hash text;     -- sha256 of the PDF the signer saw
alter table signature_requests add column if not exists decline_reason text;
alter table signature_requests add column if not exists requested_by uuid references users(id) on delete set null;
alter table signature_requests add column if not exists last_sent_at timestamptz;
create unique index if not exists signature_requests_token_idx on signature_requests (token_hash) where token_hash is not null;
create index if not exists signature_requests_letter_idx on signature_requests (letter_id, sign_order);
create index if not exists signature_requests_signer_idx on signature_requests (signer_employee_id);
create index if not exists signature_requests_file_idx on signature_requests (signature_file_id);
create index if not exists signature_requests_requested_by_idx on signature_requests (requested_by);
-- the unsigned original is kept so the audit trail can be checked against the hash the signer saw
alter table generated_letters add column if not exists original_file_id uuid references files(id) on delete set null;
alter table generated_letters add column if not exists batch_id uuid references letter_batches(id) on delete set null;
create index if not exists generated_letters_original_file_idx on generated_letters (original_file_id);
create index if not exists generated_letters_batch_idx on generated_letters (batch_id);
create index if not exists generated_letters_employee_idx on generated_letters (employee_id);

-- ---------- exit checklist: auto-ticked tasks ----------
-- task_template_items.config.auto ∈ assets_returned | access_revoked | fnf_finalized. Existing default items get theirs by title.
update task_template_items i set config = config || '{"auto":"assets_returned"}'::jsonb
  from task_templates t where t.id = i.template_id and t.kind = 'exit' and i.title = 'Return company assets' and not (i.config ? 'auto');
update task_template_items i set config = config || '{"auto":"access_revoked"}'::jsonb
  from task_templates t where t.id = i.template_id and t.kind = 'exit' and i.title = 'Revoke IT access' and not (i.config ? 'auto');
update task_template_items i set config = config || '{"auto":"fnf_finalized"}'::jsonb
  from task_templates t where t.id = i.template_id and t.kind = 'exit' and i.title = 'Final settlement' and not (i.config ? 'auto');

-- ---------- exit survey ----------
create table if not exists exit_survey_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  prompt text not null,
  type text not null check (type in ('text','rating','choice','yes_no')),
  options jsonb not null default '[]',
  required boolean not null default true,
  position int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists exit_survey_questions_tenant_idx on exit_survey_questions (tenant_id, position);

create table if not exists exit_survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  exit_request_id uuid not null references exit_requests(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  answers jsonb not null default '{}',   -- {question_id: value}
  submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (exit_request_id)
);
create index if not exists exit_survey_responses_employee_idx on exit_survey_responses (employee_id);

-- ---------- sign-up: email verification before the workspace exists (no tenant yet, so no RLS) ----------
create table if not exists signup_verifications (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  subdomain citext not null,
  code_hash text not null,
  payload jsonb not null,                -- company, names, password hash (never the password)
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists signup_verifications_email_idx on signup_verifications (email, created_at desc);
grant select, insert, update, delete on signup_verifications to erp_app, erp_admin;

-- platform emails (sign-up codes) have no tenant: recorded here, shown at /dev/mail on the apex in development
create table if not exists platform_emails (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  to_email text not null,
  subject text not null,
  html text not null,
  text_body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  provider text, provider_id text, error text,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists platform_emails_created_idx on platform_emails (created_at desc);
grant select, insert, update, delete on platform_emails to erp_app, erp_admin;

-- ---------- system roles for companies created before Finance / Recruiter existed ----------
insert into roles (tenant_id, key, name, is_system, permissions)
  select t.id, 'finance', 'Finance', true, array['expenses.approve','expenses.payout'] from tenants t
  where not exists (select 1 from roles r where r.tenant_id = t.id and r.key = 'finance');
insert into roles (tenant_id, key, name, is_system, permissions)
  select t.id, 'recruiter', 'Recruiter', true, array['hire.recruit'] from tenants t
  where not exists (select 1 from roles r where r.tenant_id = t.id and r.key = 'recruiter');

-- ---------- RLS + triggers for the new tenant tables ----------
do $$
declare t text;
begin
  foreach t in array array['letter_batches','letter_batch_items','exit_survey_questions','exit_survey_responses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
    execute format('grant select, insert, update, delete on %I to erp_app, erp_admin', t);
    execute format('drop trigger if exists %I_updated_at on %I', t, t);
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
