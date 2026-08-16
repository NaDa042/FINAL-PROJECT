## Log Ingestion and Query Service

A backend service for ingesting structured application logs and making them searchable.a simplified version of Datadog or Grafana Loki. It exposes endpoints to insert logs (`POST /logs`), query and filter them (`GET /logs`), and aggregate them into time-bucketed counts (`GET /logs/aggregate`), plus a health check (`GET /health`).

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

**Indexing:** three indexes support the query patterns the API actually needs.

- **A `GIN` index on `attributes`.** Without it, filtering by `attr.<key>=value` would require scanning every row's attributes one at a time to check for a match — fine on a small table, but far too slow once the table holds a million-plus rows. The GIN index maintains a lookup structure mapping keys/values inside the JSONB column back to the rows that contain them, so a filtered query can jump straight to matching rows instead of scanning the whole table.
- **A composite index on `(timestamp DESC, id DESC)`.** This matches the default sort order used by `GET /logs` on every request, with `id` as a tie-breaker for logs sharing the same timestamp. Without it, Postgres would need to sort the full matching result set on every query. With it, Postgres can walk the index in already-sorted order instead. This same index also serves the cursor pagination condition (`timestamp < X OR (timestamp = X AND id < Y)`) directly.
- **A composite index on `(service, timestamp DESC, id DESC)`.** Covers the common case of filtering by `service` while also needing results in timestamp order — one index serves both the filter and the sort, instead of filtering with one index and then sorting separately.

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

**Test environment:** Docker containers with the spec's resource limits applied (app: 0.5 CPU / 256 MB, PostgreSQL: 1 CPU / 1 GB), tested both via the official load generator (`loadgen.foothilltech.net`) and a local consistency/throughput test script.

**Initial result (official load generator, before optimization):**
- Throughput: ~625 logs/sec (target: 15,000/sec)
- Latency (p95): 14.9s – 32s across test stages (target: aggregate p95 under 1s)
- Application CPU: 4–7% average
- PostgreSQL CPU: 79–105% average, frequently maxed out
- Correctness: 15/15 checks passed; Reliability: 20/20; zero errors, zero dropped requests

The gap between low application CPU and high PostgreSQL CPU was the key signal: the application wasn't doing much work, while the database was maxed out — pointing to requests queuing rather than the system being genuinely compute-bound.

**Root cause:** the PostgreSQL client was created with no explicit connection pool size, defaulting to the driver's default of 10 simultaneous connections. Under concurrent load, most requests were queuing for one of those 10 connections instead of running in parallel.

**Optimizations applied:**
- **Increased and split the connection pool.** Instead of one shared pool, ingestion (`POST /logs`) and reads (`GET /logs`, `GET /logs/aggregate`, health checks) now use separate connection pools (write pool: 20, read pool: 10), so a burst of writes can't starve out concurrent queries for connections.
- **Added composite indexes** on `(timestamp DESC, id DESC)` and `(service, timestamp DESC, id DESC)`, matching the default sort/pagination order and the common service-filtered query pattern, avoiding on-the-fly sorts.
- **Tuned PostgreSQL configuration** (`shared_buffers`, `effective_cache_size`, `work_mem`, `synchronous_commit=off`, WAL settings) within the container resource limits, set directly in `docker-compose.yml`.

**Result after optimization (local test, ingestion concurrency 50–150, batch size 33):**

| Concurrency | Throughput | Ingest p95 | Aggregate p95 | Read-after-write |
|---|---|---|---|---|
| 50 | 2,467 logs/sec | 1,026ms | 1,026ms | 100% within 20s |
| 100 | 2,869 logs/sec | 1,542ms | 1,608ms | 100% within 20s |
| 150 | 3,117 logs/sec | 2,033ms | 2,033ms | 100% within 20s |

Zero errors, zero rejected requests, and 100% of writes became queryable well within the 20-second consistency window across all runs.

**Where things currently stand:** throughput improved roughly 4–5x over the initial result, but still falls short of the 15,000 logs/sec target, and aggregate query p95 latency (1.0–2.0s) still exceeds the 1-second target. As concurrency increases, both latency figures grow and throughput gains diminish — a sign that a further bottleneck exists beyond connection pooling, not yet fully diagnosed at time of writing.

**Bottlenecks discovered:** connection pool exhaustion (resolved); a secondary, not-yet-fully-identified bottleneck that emerges at higher concurrency (still under investigation).

### Known Limitations

- Throughput does not yet reach the 15,000 logs/sec target under sustained load; connection pool exhaustion was identified and fixed, improving throughput roughly 4–5x, but a further bottleneck remains at higher concurrency and hasn't been fully diagnosed yet.
- `GET /logs/aggregate` p95 latency (1.0–2.0s locally) still exceeds the 1-second target under load, though it stays close.
- Attribute values are normalized to strings at insert time, so a numeric or boolean value sent in (e.g. `"retries": 3`) is stored and returned as a string (`"retries": "3"`) rather than its original type. This trade-off enables correct, indexed `@>` filtering across all attribute value types, at the cost of not preserving the original JSON type on read.
- No authentication, multi-tenancy, or rate limiting is implemented — the service is fully open by design, consistent with the required zero-configuration default.

### Optional Features

None implemented. `docker compose up` with no environment file or manual configuration produces the complete, unauthenticated core service exactly as specified — all four required endpoints are reachable immediately, with no rate limiting, quotas, or tenancy restrictions applied.