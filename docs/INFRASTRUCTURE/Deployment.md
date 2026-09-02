# Deployment & Local Orchestration

Goal: `docker compose up` starts the whole system, and the concurrency proof runs
against the same distributed topology the task describes — several API instances
behind a load balancer.

---

# Services

Six services in the default startup:

```text
nginx      → load balancer, published on :8080
api        → NestJS HTTP, 2 replicas
worker     → BullMQ processors, 1 replica
migrate    → one-shot, runs migrations then exits 0
postgres   → PostgreSQL 16, named volume
redis      → Redis 7, no persistence, no volume
```

Two more stay behind compose profiles and do not run by default:

```text
seed            → generates ~200 doctors and ~2M appointments (minutes to run)
postgres-test   → separate database for the integration suite
```

---

# Decision: workers run as a separate service from the API

The API and the workers share one codebase but have two bootstraps. `api` scales
to two replicas; `worker` stays at one.

## Why

**Job processing must not add latency to request handling.** A worker holding a
database connection while it processes a waiting-list assignment should not
compete with an HTTP request for that connection pool.

**They scale independently.** This is the honest answer to "the clinic runs
several instances behind a load balancer": HTTP capacity and job capacity are
different problems with different bottlenecks.

**In-process workers couple the two silently.** If processors were registered
inside the API bootstrap, scaling the API to two replicas would also double the
worker pool as a side effect — a change to request capacity quietly changing job
concurrency. That is the kind of coupling that produces "why did we get two
reminders after we scaled up?" incidents.

## Consequence to be aware of

The repeatable reconciliation sweeper is registered on worker startup. BullMQ
deduplicates repeatable jobs by their key, so registering it from multiple worker
replicas is safe — but the sweeper's own actions must be idempotent regardless,
because two replicas can still execute the same scheduled occurrence
concurrently. They are; see `docs/INFRASTRUCTURE/BackgroundJobs.md`.

---

# Decision: Redis runs without persistence

`redis` is started with default options and no volume. Its data is disposable.

## Why

Delayed BullMQ jobs — every appointment reminder — exist **only** in Redis until
they fire, so `docker compose restart redis` does drop the delayed set. That is
accepted, because it drops a timer and not a record.

Every reminder has a `PENDING` row in `notifications` written inside the booking
transaction, and the reconciliation sweeper sends anything whose `scheduled_at`
has passed. After a restart, a reminder that was already due goes out on the next
sweep — bounded by about a minute, the same bound already accepted for a job lost
between commit and enqueue. Reminders still in the future are not affected at
all: nothing needs to be rebuilt, because the sweeper will pick them up when
their time comes.

`--appendonly yes` on a named volume was the earlier decision and was reversed.
It buys a shorter window on one restart path, and in exchange Redis holds a
durable second copy of an intent that PostgreSQL already owns — state the project
would then have to keep explaining it does not trust. Redis is a scheduler;
PostgreSQL is the source of record. Leaving Redis disposable makes that true
instead of aspirational.

None of the correctness claims depend on this. "At most one reminder" comes from
`UNIQUE (appointment_id, type)` and the conditional `PENDING -> SENT` update.
"No reminder for a cancelled appointment" comes from the worker re-reading
`appointments.status`.

---

# Decision: migrations run as a one-shot service, not on app start

`migrate` depends on `postgres: service_healthy`, runs the TypeORM migrations,
and exits. `api` and `worker` both depend on
`migrate: service_completed_successfully`.

## Why

**`docker compose up` stays a single command** while `synchronize: true` remains
permanently off. That is exactly what the task asks for, without the shortcut it
forbids.

**Nothing accepts traffic before the schema is ready.** With migrations running
inside app startup and two API replicas, both replicas would attempt to migrate
simultaneously on a cold start. TypeORM takes an advisory lock, so this usually
works — but "usually" is a poor property for schema changes, and the failure mode
is a confusing startup crash rather than a clear error.

**The exit code is a signal.** A failed migration stops the whole stack with an
obvious cause, instead of leaving replicas crash-looping against a schema that
does not match the code.

---

# Health Checks

`postgres` uses `pg_isready`. `api` uses `GET /health`.

`nginx` routes only to replicas passing their health check, so a replica that is
still booting does not receive requests. This matters directly for the
concurrency proof: without it, some of the concurrent requests could hit a
replica that is not ready and fail for the wrong reason, which would muddy the
result.

`GET /health` is therefore part of the system, not decoration.

---

# Load Balancer

`nginx` proxies to `api:3000`. Compose's internal DNS resolves that name to all
healthy replicas and round-robins between them, so no explicit upstream list is
needed and replica count can change without editing the nginx config.

Published on `:8080`. The concurrency script targets `http://localhost:8080`, so
its requests genuinely spread across processes.

---

# Configuration

All configuration comes from environment variables, with a committed
`.env.example`. Nothing is hardcoded.

Required variables include:

```text
NODE_ENV
PORT
DATABASE_URL
REDIS_URL
JWT_SECRET
JWT_EXPIRES_IN
CLINIC_TZ
API_REPLICAS
```

`CLINIC_TZ` is business configuration, not an environment detail — it changes
what the API computes. It is documented in the README alongside the
single-timezone limitation.

---

# Version Pins

- **PostgreSQL 16** — `range_agg` and multirange types require 14 or newer, and
  the analytics capacity query depends on them. The `btree_gist` extension is
  created by a migration, not manually.
- **Redis 7** — BullMQ's supported baseline.

Pinning majors rather than using `latest` keeps a rebuild months from now from
changing behaviour underneath the project.

---

# Running

```bash
cp .env.example .env
docker compose up --build          # whole stack, migrations included
docker compose --profile seed up seed    # optional: ~2M appointment rows
npm run test:concurrency           # fires at nginx on :8080
```

The concurrency proof is a separate command rather than part of `up`, because it
is a claim to be demonstrated on request, not a startup step.
