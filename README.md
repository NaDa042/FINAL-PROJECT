## Log Ingestion and Query Service

A backend service for ingesting structured application logs and making them searchable — a simplified version of Datadog or Grafana Loki. It exposes endpoints to insert logs (`POST /logs`), query and filter them (`GET /logs`), and aggregate them into time-bucketed counts (`GET /logs/aggregate`), plus a health check (`GET /health`).

### Getting Started

1. Clone the repository.
2. Run:
   ```bash
   docker compose up
   ```
   This builds and starts both containers — the API service and PostgreSQL — with no additional setup required.
3. Confirm the service is ready:
   ```bash
   curl http://localhost:8080/health
   ```
   A `200` response means the database is connected, migrations have run, and the service is ready to accept logs.
4. Start sending logs to `POST /logs`, or query existing ones via `GET /logs`.

### API Documentation

#### `GET /health`

Checks whether the service is ready to accept traffic. Returns `200` only after three things are confirmed: the database connection has been established, migrations have been applied, and the service is ready to accept logs. If the database is unreachable or migrations haven't completed, it returns `503` instead.

| Status | Meaning |
|---|---|
| `200` | Service is healthy and ready |
| `503` | Database unreachable, or migrations not yet applied |

#### `POST /logs`

Ingests a batch of log entries. Always expects a batch — even a single log must be wrapped in an array.

**Request body:**
```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
    }
  ]
}
```

**Fields, per log entry:**
- `timestamp` — required, ISO 8601 format, cannot be more than 5 minutes in the future
- `level` — required, one of `debug`, `info`, `warn`, `error`
- `service` — required, non-empty string
- `message` — required, non-empty string
- `attributes` — optional, flat key/value object; values can be strings, numbers, or booleans (no nested objects or arrays)

**How acceptance works:** each entry in the batch is validated independently. One invalid entry does not fail the whole batch — valid entries are still accepted and inserted, while invalid ones are rejected individually, each with the reason they failed.

**Response:**
```json
{
  "accepted": 9,
  "rejected": [
    { "index": 3, "reason": "invalid level: 'critical'" }
  ]
}
```

| Status | Meaning |
|---|---|
| `200` | At least one entry was accepted |
| `400` | All entries were rejected, or the request body itself is malformed |

#### `GET /logs`

Searches and filters stored logs. Every parameter is optional and can be freely combined with the others.

| Parameter | Meaning |
|---|---|
| `service` | Exact match on service name |
| `level` | Exact match on log level |
| `since` | Inclusive start of a time range |
| `until` | Exclusive end of a time range |
| `attr.<key>` | Matches logs where the given attribute key equals the given value, e.g. `attr.user_id=42` |
| `q` | Case-insensitive substring match against the message |
| `limit` | Max number of results to return (default 100, max 1000) |
| `cursor` | An opaque token from a previous response, used to fetch the next page of results |

Results come back sorted by `timestamp`, newest first. When two logs share the exact same timestamp, `id` is used as a tie-breaker so the ordering stays consistent across requests.

**Response:**
```json
{
  "logs": [
    {
      "id": "62978429-6d59-49cc-ac3d-6ae7f1cea47d",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJpZCI6..."
}
```

`next_cursor` is `null` once there are no more results to page through. Passing an invalid `level`, a malformed timestamp, an `until` earlier than `since`, a non-numeric or out-of-range `limit`, or a broken `cursor` all return `400` with `{ "error": "<description>" }`.

#### `GET /logs/aggregate`

Instead of returning individual log rows, this counts how many logs fall into each time bucket over a given range — useful for graphing volume or error rates over time.

| Parameter | Required | Meaning |
|---|---|---|
| `since` | Yes | Inclusive start of the range being counted |
| `until` | Yes | Exclusive end of the range being counted |
| `bucket` | Yes | Width of each time bucket — `1m`, `5m`, `1h`, or `1d` |
| `group_by` | No | Splits each bucket further by `service` or `level` |
| `service` | No | Only count logs matching this service |
| `level` | No | Only count logs matching this level |
| `attr.<key>` | No | Only count logs where the given attribute key equals the given value |
| `q` | No | Only count logs whose message contains this text (case-insensitive) |

**Response:**
```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 },
    { "start": "2026-07-20T14:00:00Z", "group": "auth", "count": 42 }
  ]
}
```

Buckets are ordered by `start` time, ascending. When `group_by` isn't provided, `group` is `null`. The same `400` error format as `GET /logs` applies to invalid parameters here too.

### Schema and Index Design

A single `logs` table holds every log entry:

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` | Primary key, generated automatically for each row — no need to supply one |
| `timestamp` | `TIMESTAMPTZ` | Timezone-aware, matching the timestamp format used throughout the API contract |
| `level` | Postgres `ENUM` (`debug`, `info`, `warn`, `error`) | Restricts the column to exactly these four values at the database level, not just in application code |
| `service` | `TEXT` | |
| `message` | `TEXT` | |
| `attributes` | `JSONB`, nullable | See "Attribute Storage Strategy" below for why JSONB was chosen |

**Indexing:** four indexes support the query patterns the API actually needs.

- **A `GIN` index on `attributes`.** Without it, filtering by `attr.<key>=value` would require scanning every row's attributes one at a time to check for a match — fine on a small table, but far too slow once the table holds a million-plus rows. The GIN index maintains a lookup structure mapping keys/values inside the JSONB column back to the rows that contain them, so a filtered query can jump straight to matching rows instead of scanning the whole table.
- **A composite index on `(timestamp DESC, id DESC)`.** This matches the default sort order used by `GET /logs` on every request, with `id` as a tie-breaker for logs sharing the same timestamp. Without it, Postgres would need to sort the full matching result set on every query. With it, Postgres can walk the index in already-sorted order instead. This same index also serves the cursor pagination condition (`timestamp < X OR (timestamp = X AND id < Y)`) directly.
- **A composite index on `(service, timestamp DESC, id DESC)`.** Covers the common case of filtering by `service` while also needing results in timestamp order — one index serves both the filter and the sort, instead of filtering with one index and then sorting separately.
- **A composite index on `(level, timestamp DESC, id DESC)`.** Added after load testing showed `level`-filtered queries had no fast path and fell back to a full scan plus sort, the same problem the `service` index above solves.

### Attribute Storage Strategy

Every log can carry an arbitrary set of key/value attributes (`user_id`, `region`, `retries`, and so on), and the set of possible keys isn't known in advance — different services can send completely different attributes on every request. Fixed columns can't handle this, since the schema would need to change every time a new attribute key showed up in real traffic. Instead, attributes are stored as a single `JSONB` column on the `logs` table — one row per log regardless of how many attributes it carries.

**Why JSONB instead of plain JSON:** Postgres's plain `JSON` type stores the value as raw text and has to re-parse that text from scratch on every query. `JSONB` parses the value once, at insert time, into Postgres's internal binary structure, so every later query reads the already-parsed structure directly. The trade-off is a slightly heavier insert, in exchange for much faster queries — a good fit here, since each log is inserted once but can be queried, filtered, and aggregated many times over.

**Filtering on attributes (`attr.<key>=value`):** the query handler collects every `attr.*` parameter from the request into a plain object, then builds one JSONB containment condition per key/value pair:

```ts
sql`${logs.attributes} @> ${JSON.stringify({ [key]: value })}::jsonb`
```

These conditions are combined with `AND`, alongside the other filters, so a request with multiple `attr.*` parameters only matches logs that satisfy all of them. `@>` is the operator GIN indexes on JSONB are best suited for, so this keeps attribute filtering backed by the index rather than falling back to a slower comparison path.

**A real correctness issue this ran into, and how it was resolved:** values coming from the URL are always strings, but the values inside an attributes object can be strings, numbers, or booleans, and `@>` does a strict, type-aware match — a filter like `attr.retries=3` would fail to match a stored `retries: 3`, since the string `"3"` and the number `3` aren't equal under containment. Rather than give up the indexed `@>` comparison, attribute values are normalized to strings at insert time, before they're stored — so every attribute value in the database is consistently a string, and a string coming from a query parameter always matches correctly.

### Retention Strategy

Logs older than a configurable cutoff (`RETENTION_DAYS`, default 30) are deleted automatically, without needing any manual step.

Deletion runs once when the service starts, and then again every hour for as long as the service keeps running. Each run doesn't issue a single large `DELETE` across the whole expired range — instead, it deletes in small batches (10,000 rows at a time), repeating until nothing older than the cutoff is left. Deleting in batches avoids holding a long lock on the `logs` table, which would otherwise block ingestion from proceeding while a large deletion is in progress.

### Measured Performance Results

**Test environment:** Docker containers with the spec's resource limits applied (app: 0.5 CPU / 256 MB, PostgreSQL: 1 CPU / 1 GB), tested both via the official load generator (`loadgen.foothilltech.net`) and local scripts (`consistency-test.mjs`, `logs-load-test.mjs`) that reproduce the same mix of concurrent ingestion, aggregation, and read-after-write traffic for faster iteration.

**Starting point (official load generator, before any optimization):**
- Throughput: ~625 logs/sec (target: 15,000/sec)
- Latency p95: 14.9s – 32s across test stages
- Application CPU: 4–7% average — PostgreSQL CPU: 79–105% average, frequently maxed out
- Correctness: 15/15; Reliability: 20/20; zero errors, zero dropped requests

Low application CPU next to maxed-out PostgreSQL CPU was the first real clue: the app wasn't doing much work, while the database was saturated — pointing at requests queuing somewhere, not at the system being genuinely out of compute.

**Final result (official load generator, current submission):**

| Metric | Score |
|---|---|
| Overall | **66.69 / 100** (rank #10) |
| Performance | 16.85 / 50 |
| Reliability | 20 / 20 |
| Correctness | 15 / 15 |
| Queries | 14.84 / 15 |

Load scenario (15,000 logs/s offered for 120s): 166.7K logs accepted (~1,389 logs/sec sustained), zero rejected, zero errors. Ingestion p95 **1.12s** (down from double digits). Aggregate p95 **9ms** (down from 10–29 **seconds**). 75/75 correctness checks passed throughout.

**The optimization journey — each fix traced back to one of two root causes: not enough database connections for the concurrent demand, or the database's single CPU core being shared between reads and writes with no way to prioritize either.**

1. **Missing index on `timestamp`.** The very first fix — every query filters or sorts by timestamp, and there was no index for it, so every query was a full table scan. Added the `(timestamp DESC, id DESC)` composite index.
2. **Connection pool exhaustion.** The Postgres client had no explicit pool size, defaulting to 10. Under concurrent load, most requests queued for one of those 10 connections instead of running in parallel — this explained the low-app-CPU / high-Postgres-CPU pattern above. Fixed by giving ingestion and reads separate, dedicated pools (write: 20, read: 10–20 depending on the run) so a burst of writes can never fully starve concurrent reads.
3. **`synchronous_commit=off` and `wal_compression=on`.** Even after fixing the pool, ingestion was still spending real time waiting for each write to be flushed to disk before acknowledging it. Turning this off cut ingestion p95 by 80–96% across every test stage. Trade-off: a `200` response is durable against an application crash but not against an OS-level crash within the flush window — see Known Limitations.
4. **In-memory rolling pre-aggregation cache for `GET /logs/aggregate`.** This was the single biggest win. Even with the pool and WAL fixes in place, `GET /logs/aggregate` still queued behind ingestion — both were competing for the same single Postgres CPU core, and giving ingestion more room to run just meant it consumed *more* of that shared core, squeezing aggregate harder. The fix removes Postgres from the hot path entirely for the common case: the app keeps a live in-process count of logs per `(second, service, level)` as they're ingested, and answers any `GET /logs/aggregate` request with no `attr.`/`q` filter and a recent window (last 3 hours) straight from memory — zero Postgres round-trips. Anything outside that (attribute filters, message search, older windows) falls through to the original Postgres query, unchanged. This is what took aggregate p95 from 10–29 seconds to single-digit milliseconds. See `src/rollup.ts`.
5. **`GET /logs` still slows under heavy concurrent read load, especially for `attr.`/`level` filters with no time range.** Isolated (`EXPLAIN ANALYZE`, no concurrent load), an attribute-filtered query over 1M rows runs in ~270ms — not itself the problem. Under 20 concurrent readers with no ingestion running at all, the same query pattern degraded to a 12–25 second p50/p95. Same root cause as #2: with the rollup cache now handling most aggregate traffic, the read pool is used almost entirely by `GET /logs`, and 10 connections isn't enough headroom for sustained concurrent read traffic. Addressed by increasing the read pool further.

**Where things currently stand:** ingestion throughput improved roughly 2x over the initial official result and ingestion/aggregate latency both improved by one to three orders of magnitude, but sustained throughput still falls short of the 15,000 logs/sec target under the official load generator's full concurrency. Every bottleneck found so far has traced back to connection pool sizing or shared single-CPU contention between reads and writes — no query has been found that's inherently too slow to serve at the required scale.

### Known Limitations

- Throughput does not yet reach the 15,000 logs/sec target under sustained load. The official run sustains roughly 1,000–1,400 logs/sec — a real improvement over the initial ~625 logs/sec, but still well short of target. Every bottleneck identified so far (missing indexes, connection pool sizing, WAL flush waiting, single-CPU contention between reads and writes) has been diagnosed and addressed; the remaining gap has not been traced to any one further cause.
- `GET /logs/aggregate` now meets its 1-second p95 target comfortably (measured 6–11ms on the official run) via the in-memory rollup cache described above. That cache only covers requests with no `attr.`/`q` filter and a window within the last 3 hours; anything outside that still queries Postgres directly and is subject to the same contention as `GET /logs` below.
- `GET /logs` can slow significantly under sustained concurrent read load, particularly for `attr.`/`level`-filtered queries with no `since`/`until` range — the query itself is fast in isolation (~270ms at 1M rows), but throughput is limited by the read connection pool under concurrent demand. Requests that include a time range are unaffected, since they're bounded by the `(timestamp DESC, id DESC)` index regardless of filter.
- The rolling aggregate cache lives in a single process's memory. This is correct for the current single-instance deployment; it would need to move to a shared store (e.g. Redis) if the application were ever scaled to multiple replicas.
- `synchronous_commit=off` means an accepted (`200`) ingest request is durable against an application crash but not against an OS-level crash within the WAL flush window. This trades a small, well-understood durability window for a substantial (80–96%) reduction in ingestion latency.
- Attribute values are normalized to strings at insert time, so a numeric or boolean value sent in (e.g. `"retries": 3`) is stored and returned as a string (`"retries": "3"`) rather than its original type. This trade-off enables correct, indexed `@>` filtering across all attribute value types, at the cost of not preserving the original JSON type on read.
- No authentication, multi-tenancy, or rate limiting is implemented — the service is fully open by design, consistent with the required zero-configuration default.

### Optional Features

None implemented. `docker compose up` with no environment file or manual configuration produces the complete, unauthenticated core service exactly as specified — all four required endpoints are reachable immediately, with no rate limiting, quotas, or tenancy restrictions applied.