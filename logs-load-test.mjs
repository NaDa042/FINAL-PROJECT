// logs-load-test.mjs
// We already know POST /logs and GET /logs/aggregate are fast now.
// This tests the one endpoint we never checked: plain GET /logs, with a
// mix of realistic filters, running at the same time as heavy ingestion.
//
// Run: node logs-load-test.mjs [durationSeconds] [ingestWorkers] [readWorkers]
// Example: node logs-load-test.mjs 45 80 20

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const DURATION_S = Number(process.argv[2] ?? 45);
const INGEST_WORKERS = Number(process.argv[3] ?? 80);
const READ_WORKERS = Number(process.argv[4] ?? 20);
const BATCH_SIZE = 33;

const SERVICES = ["checkout", "auth", "payments", "inventory", "shipping"];
const LEVELS = ["debug", "info", "warn", "error"];
const REGIONS = ["eu-west", "us-east", "us-west", "ap-south"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBatch(size) {
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < size; i++) {
    entries.push({
      timestamp: new Date(now - Math.floor(Math.random() * 1000)).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      message: `sample message ${Math.random().toString(36).slice(2)}`,
      attributes: {
        user_id: String(Math.floor(Math.random() * 100000)),
        region: pick(REGIONS),
        retries: Math.floor(Math.random() * 5),
      },
    });
  }
  return { logs: entries };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function waitForHealth() {
  process.stdout.write("Waiting for /health...\n");
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function ingestWorker(stopAt, stats) {
  while (Date.now() < stopAt) {
    try {
      const res = await fetch(`${BASE_URL}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(randomBatch(BATCH_SIZE)),
      });
      const json = await res.json().catch(() => null);
      stats.requests++;
      if (res.status === 200 && json) stats.accepted += json.accepted ?? 0;
      else stats.errors++;
    } catch {
      stats.requests++;
      stats.errors++;
    }
  }
}

// Mix of query shapes, so we're not only testing one path
function randomQueryUrl() {
  const kind = Math.floor(Math.random() * 4);
  if (kind === 0) return `${BASE_URL}/logs?limit=50`;
  if (kind === 1) return `${BASE_URL}/logs?service=${pick(SERVICES)}&limit=50`;
  if (kind === 2) return `${BASE_URL}/logs?level=${pick(LEVELS)}&limit=50`;
  return `${BASE_URL}/logs?attr.region=${pick(REGIONS)}&limit=50`;
}

async function readWorker(stopAt, stats) {
  while (Date.now() < stopAt) {
    const url = randomQueryUrl();
    const start = performance.now();
    try {
      const res = await fetch(url);
      const elapsed = performance.now() - start;
      stats.requests++;
      stats.latencies.push(elapsed);
      if (res.status !== 200) stats.errors++;
    } catch {
      stats.requests++;
      stats.errors++;
    }
  }
}

async function main() {
  await waitForHealth();
  console.log(
    `Running ${DURATION_S}s: ${INGEST_WORKERS} ingest workers, ${READ_WORKERS} GET /logs workers\n`
  );

  const stopAt = Date.now() + DURATION_S * 1000;
  const ingestStats = { requests: 0, accepted: 0, errors: 0 };
  const readStats = { requests: 0, errors: 0, latencies: [] };

  const workers = [];
  for (let i = 0; i < INGEST_WORKERS; i++) workers.push(ingestWorker(stopAt, ingestStats));
  for (let i = 0; i < READ_WORKERS; i++) workers.push(readWorker(stopAt, readStats));

  await Promise.all(workers);

  console.log("=== INGEST (POST /logs) ===");
  console.log(`Requests: ${ingestStats.requests}, Errors: ${ingestStats.errors}`);
  console.log(
    `Accepted: ${ingestStats.accepted}  (${(ingestStats.accepted / DURATION_S).toFixed(1)} logs/sec)`
  );

  const sorted = readStats.latencies.slice().sort((a, b) => a - b);
  console.log("\n=== READ (GET /logs, mixed filters) ===");
  console.log(`Requests: ${readStats.requests}, Errors: ${readStats.errors}`);
  console.log(
    `Latency  p50: ${percentile(sorted, 50).toFixed(0)}ms  ` +
      `p95: ${percentile(sorted, 95).toFixed(0)}ms  ` +
      `p99: ${percentile(sorted, 99).toFixed(0)}ms  ` +
      `max: ${sorted.length ? sorted[sorted.length - 1].toFixed(0) : 0}ms`
  );
}

main();
