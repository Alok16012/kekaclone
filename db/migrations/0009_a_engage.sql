-- Engage (Home wall): track when an announcement's audience was notified, so scheduled
-- announcements notify exactly once when they go live (publishDue() claims rows with a row lock).
alter table posts add column if not exists notified_at timestamptz;
update posts set notified_at = publish_at where notified_at is null and publish_at <= now();

-- pinned announcements are read on every Home load
create index if not exists posts_pinned_idx on posts (tenant_id, pinned_until) where pinned_until is not null;
-- scheduled announcements waiting to go live
create index if not exists posts_due_idx on posts (tenant_id, publish_at) where notified_at is null;
-- praise received on a profile
create index if not exists praise_recipients_employee_idx on praise_recipients (employee_id, post_id);
