# erp

Multi-tenant HRMS for Indian companies: Next.js 16 (App Router), Postgres with row-level security per tenant, server actions for every mutation.

## Getting started

```bash
pnpm install
cp .env.example .env.local          # set DATABASE_URL, DATABASE_ADMIN_URL, ROOT_DOMAIN, SESSION_SECRET
pnpm db:migrate && pnpm db:seed     # schema + a demo company (acme)
pnpm dev                            # http://acme.localhost:3100
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (pure rules), `pnpm smoke:all` (database-backed end-to-end checks against the seeded demo tenant), `pnpm build`.

## Background jobs

Everything time-based runs from ONE script, `pnpm jobs:daily`. For every live tenant it runs, in order:

1. `exits` – relieve people whose last working day has passed
2. `job_changes` – apply dated transfers / promotions due today
3. `probation` – auto-confirm probation under auto-confirm policies, remind managers (once a day)
4. `approval_reassign` – move pending approval steps away from approvers who are on leave, have a hand-over, or have left
5. `attendance` – process yesterday's attendance (once a day)
6. `leave` – monthly accrual and comp-off expiry
7. `approval_timers` – escalation and auto-approval set in Settings → Approvals
8. `helpdesk` – SLA breaches and escalations
9. `engage` – publish scheduled announcements
10. `digest` – pending-approvals email to every approver (once a day)
11. `email` – deliver queued email

Payroll / loan modules append their own steps through `EXTRA_STEPS` in `src/server/modules/corehr/scheduler.ts`.

The run is safe to repeat: a Postgres advisory lock stops two runs overlapping, once-a-day steps that already finished for a date are skipped (recorded in `scheduler_runs`, visible in Settings → Scheduled jobs), and each step is idempotent on its own.

```bash
pnpm jobs:daily                             # all tenants, today (IST)
pnpm jobs:daily -- --date 2026-11-02        # catch up a missed day
pnpm jobs:daily -- --tenant acme --force    # one tenant, re-run once-a-day steps
pnpm jobs:daily -- --only attendance,leave  # just these steps
```

### Running it on a schedule

Cron, once a day shortly after midnight IST (the host's crontab is in its own time zone; `CRON_TZ` works on most Linux crons, otherwise convert the hour):

```cron
CRON_TZ=Asia/Kolkata
15 0 * * * cd /srv/erp && /usr/bin/pnpm jobs:daily >> /var/log/erp-jobs.log 2>&1
```

Running it a second time in the day (e.g. every hour) is fine and makes escalations, hand-overs and queued email timely; the once-a-day steps are skipped. systemd timer, Kubernetes CronJob or a hosted scheduler all work the same way: call `pnpm jobs:daily` from the app directory with `.env.local` (or the same variables in the environment). The exit code is non-zero when any step failed; the failure is also recorded in `scheduler_runs`.

The individual scripts (`pnpm jobs:attendance`, `jobs:leave`, `jobs:exits`, `jobs:helpdesk`, `jobs:statutory-rates`) still exist for one-off runs and debugging.
