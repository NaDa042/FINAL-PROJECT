-- explain.sql
-- Run these one at a time (copy/paste into psql) AFTER seed.sql has run.
-- Connect with:
--   docker compose exec db psql -U nada -d logs_db

-- ============================================================
-- 1. Confirm indexes exist
-- ============================================================
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'logs';

-- ============================================================
-- 2. GET /logs/aggregate - narrow time window (last hour)
--    This is the exact query shape aggLogs.ts builds, bucket=1m.
--    Should show "Index Scan" or "Bitmap Heap Scan" on timestamp_id_idx.
-- ============================================================
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  to_timestamp(floor(extract(epoch from "timestamp") / 60) * 60) AS start,
  service AS "group",
  count(*)::int AS count
FROM logs
WHERE "timestamp" >= NOW() - interval '1 hour'
  AND "timestamp" < NOW()
GROUP BY 1, 2
ORDER BY 1;

-- ============================================================
-- 3. GET /logs/aggregate - WIDE window (full 30-day dataset)
--    With a range this wide, a Seq Scan can actually be the CORRECT
--    plan (reading most of the table via index lookups one row at a
--    time is slower than one sequential pass). If you see Seq Scan
--    here, that alone isn't a bug -- compare execution time, not plan
--    type, against the 1s p95 target.
-- ============================================================
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  to_timestamp(floor(extract(epoch from "timestamp") / 3600) * 3600) AS start,
  service AS "group",
  count(*)::int AS count
FROM logs
WHERE "timestamp" >= NOW() - interval '30 days'
  AND "timestamp" < NOW()
GROUP BY 1, 2
ORDER BY 1;

-- ============================================================
-- 4. GET /logs - typical filtered + paginated query
-- ============================================================
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM logs
WHERE service = 'checkout'
ORDER BY "timestamp" DESC, id DESC
LIMIT 101;

-- ============================================================
-- 5. GET /logs - attribute filter (this is what the GIN index is for)
-- ============================================================
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM logs
WHERE attributes @> '{"region":"eu-west"}'::jsonb
ORDER BY "timestamp" DESC, id DESC
LIMIT 101;

-- ============================================================
-- 6. Check actual index usage counters (run before AND after a
--    load test to see idx_scan climbing / seq_scan staying flat)
-- ============================================================
SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch
FROM pg_stat_user_tables
WHERE relname = 'logs';

-- ============================================================
-- 7. Table + index sizes (useful context for the README)
-- ============================================================
SELECT
  indexrelname AS index_name,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'logs';

SELECT pg_size_pretty(pg_relation_size('logs')) AS table_heap_size;
