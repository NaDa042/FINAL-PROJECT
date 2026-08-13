// loadtest.mjs
// Zero-dependency local load test that mirrors the grader's traffic shape:
// many concurrent POST /logs workers, plus a GET /logs/aggregate check
// once per second (matching the spec's "one aggregation request per
// second during the ingestion test").
//
// Requires Node 18+ (uses global fetch). Run with:
//   node loadtest.mjs [durationSeconds] [concurrency] [batchSize]
//
// Examples:
//   node loadtest.mjs 30 50 33      # 30s, 50 concurrent workers, batch=33
//   node loadtest.mjs 60 100 100    # heavier run

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const DURATION_S = Number(process.argv[2] ?? 30);
const CONCURRENCY = Number(process.argv[3] ?? 50);
const BATCH_SIZE = Number(process.argv[4] ?? 33);

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
  return JSON.stringify({ logs: entries });
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function ingestWorker(stopAt, stats) {
  while (Date.now() < stopAt) {
    const body = randomBatch(BATCH_SIZE);
    const start = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const elapsed = performance.now() - start;
      const json = await res.json().catch(() => null);
      stats.requests++;
      stats.latencies.push(elapsed);
      if (res.status === 200 && json) {
        stats.accepted += json.accepted ?? 0;
        stats.rejected += json.rejected?.length ?? 0;
      } else {
        stats.errors++;
      }
    } catch {
      stats.requests++;
      stats.errors++;
    }
  }
}

async function aggregateWorker(stopAt, stats) {
  while (Date.now() < stopAt) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    const url = `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=1m`;
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
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForHealth() {
  process.stdout.write("Waiting for /health...\n");
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) return;
    } catch {
      // service not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  await waitForHealth();
  console.log(
    `Service healthy. Starting load test: ${DURATION_S}s, concurrency=${CONCURRENCY}, batchSize=${BATCH_SIZE}\n`
  );

  const stopAt = Date.now() + DURATION_S * 1000;
  const ingestStats = { requests: 0, accepted: 0, rejected: 0, errors: 0, latencies: [] };
  const aggStats = { requests: 0, errors: 0, latencies: [] };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(ingestWorker(stopAt, ingestStats));
  workers.push(aggregateWorker(stopAt, aggStats));

  await Promise.all(workers);

  const sortedIngest = ingestStats.latencies.slice().sort((a, b) => a - b);
  const sortedAgg = aggStats.latencies.slice().sort((a, b) => a - b);

  console.log("=== INGEST (POST /logs) ===");
  console.log(`Requests: ${ingestStats.requests}, Errors: ${ingestStats.errors}`);
  console.log(`Accepted logs: ${ingestStats.accepted}, Rejected: ${ingestStats.rejected}`);
  console.log(`Throughput: ${(ingestStats.accepted / DURATION_S).toFixed(1)} logs/sec`);
  console.log(
    `Latency  p50: ${percentile(sortedIngest, 50).toFixed(0)}ms  ` +
      `p95: ${percentile(sortedIngest, 95).toFixed(0)}ms  ` +
      `p99: ${percentile(sortedIngest, 99).toFixed(0)}ms`
  );

  console.log("\n=== AGGREGATE (GET /logs/aggregate, 1/sec) ===");
  console.log(`Requests: ${aggStats.requests}, Errors: ${aggStats.errors}`);
  console.log(
    `Latency  p50: ${percentile(sortedAgg, 50).toFixed(0)}ms  ` +
      `p95: ${percentile(sortedAgg, 95).toFixed(0)}ms  ` +
      `p99: ${percentile(sortedAgg, 99).toFixed(0)}ms`
  );
}

main();
