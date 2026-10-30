-- servicedesk: helpdesk + assets. The tables already exist in 0001 (ticket_categories, tickets, ticket_messages,
-- asset_categories, asset_types, assets, asset_assignments, asset_requests, counters, files). This adds only what was missing.

-- SLA escalation is sent once per breach (the helpdesk job is safe to re-run); reopening restarts the resolution clock
alter table tickets add column first_response_escalated_at timestamptz;
alter table tickets add column resolution_escalated_at timestamptz;
alter table tickets add column reopened_count integer not null default 0;
create index on tickets (tenant_id, status, first_response_due_at);
create index on tickets (tenant_id, raised_by_employee_id, updated_at desc);
create index on ticket_categories using gin (assignee_employee_ids);

-- who handed an asset over / took it back, the condition at hand-over, notes, and the request it fulfilled
alter table asset_assignments add column assigned_by uuid references users(id) on delete set null;
alter table asset_assignments add column returned_by uuid references users(id) on delete set null;
alter table asset_assignments add column assign_condition text;
alter table asset_assignments add column notes text;
alter table asset_assignments add column return_notes text;
alter table asset_assignments add column request_id uuid references asset_requests(id) on delete set null;
create index on asset_assignments (assigned_by);
create index on asset_assignments (returned_by);
create index on asset_assignments (request_id);
create index on asset_assignments (employee_id, returned_at);
alter table asset_assignments add constraint asset_assignments_return_condition_check
  check (return_condition is null or return_condition in ('new','good','fair','damaged','lost'));
alter table asset_assignments add constraint asset_assignments_assign_condition_check
  check (assign_condition is null or assign_condition in ('new','good','fair','damaged','lost'));
alter table asset_assignments add constraint asset_assignments_recovery_check check (recovery_paise >= 0);
alter table asset_assignments add constraint asset_assignments_returned_check check (returned_at is not null or (return_condition is null and recovery_paise = 0));
alter table assets add constraint assets_cost_check check (cost_paise is null or cost_paise >= 0);

-- at most one open (pending or approved) request per person per asset type
create unique index asset_requests_one_open on asset_requests (employee_id, type_id) where status in ('pending','approved');
