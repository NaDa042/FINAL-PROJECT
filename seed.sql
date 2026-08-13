-- seed.sql
-- Bulk-generates ~1,000,000 log rows spanning the last 30 days directly
-- inside Postgres. This bypasses the HTTP API entirely (generating 1M rows
-- through POST /logs would itself take a long time and tests a different
-- thing) so you get a realistic dataset size to test QUERY performance
-- against in seconds, not hours.
--
-- Run it with:
--   docker compose exec -T db psql -U nada -d logs_db < seed.sql
--
-- (run from the same directory as your docker-compose.yml, with the stack
-- already up via `docker compose up -d`)

INSERT INTO logs (id, "timestamp", level, service, message, attributes)
SELECT
  gen_random_uuid(),
  NOW() - (random() * interval '30 days'),
  (ARRAY['debug','info','warn','error']::level[])[(floor(random()*4)+1)::int],
  (ARRAY['checkout','auth','payments','inventory','shipping'])[(floor(random()*5)+1)::int],
  'sample log message ' || gs,
  jsonb_build_object(
    'user_id', (floor(random()*100000))::int::text,
    'region', (ARRAY['eu-west','us-east','us-west','ap-south'])[(floor(random()*4)+1)::int],
    'retries', (floor(random()*5))::int
  )
FROM generate_series(1, 1000000) AS gs;

-- Refresh planner statistics so the query planner has accurate row-count
-- estimates for the new data. Without this, EXPLAIN ANALYZE right after a
-- big bulk load can show stale/misleading plans.
ANALYZE logs;

-- Quick sanity check
SELECT count(*) AS total_rows FROM logs;
