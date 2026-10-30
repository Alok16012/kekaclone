-- "Remember this device for 30 days": the sign-in code step is skipped for a browser holding a valid trusted-device
-- token. Stored like other one-time tokens (sha256 of a random secret); consumed on password reset.
alter table auth_tokens drop constraint auth_tokens_purpose_check;
alter table auth_tokens add constraint auth_tokens_purpose_check
  check (purpose in ('invite','reset_password','verify_email','login_otp','mfa_otp','esign_otp','trusted_device'));
create index if not exists auth_tokens_trusted_device_idx on auth_tokens (user_id) where purpose = 'trusted_device' and consumed_at is null;
