-- exitdocs: exits + documents. Most tables already exist in 0001 (exit_requests, exit_reasons, notice_period_policies,
-- task_templates/items, lifecycle_processes, tasks, document_folders, org_documents, document_acks, employee_documents,
-- letter_templates, generated_letters, files). This adds only what they were missing.

-- one default notice period per company (used for people with no policy assigned); names unique per company
alter table notice_period_policies add column is_default boolean not null default false;
create unique index notice_period_policies_one_default on notice_period_policies (tenant_id) where is_default;
alter table notice_period_policies add constraint notice_period_policies_tenant_name_key unique (tenant_id, name);

-- the exit's checklist (a lifecycle process of kind 'exit')
alter table exit_requests add column process_id uuid references lifecycle_processes(id) on delete set null;
create index on exit_requests (process_id);
create index on exit_requests (tenant_id, status, last_working_date);

-- HR's tracking list and the employee's "what do I still need to acknowledge" lookup
create index on document_acks (employee_id, acknowledged_at);
