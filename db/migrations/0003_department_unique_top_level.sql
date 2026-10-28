-- Two top-level departments with the same name slipped through: NULL parent_ids are distinct in a plain unique constraint.
alter table departments drop constraint if exists departments_tenant_id_parent_id_name_key;
alter table departments add constraint departments_tenant_id_parent_id_name_key unique nulls not distinct (tenant_id, parent_id, name);
