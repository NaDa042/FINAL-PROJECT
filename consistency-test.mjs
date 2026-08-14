// consistency-test.mjs
// Mirrors the grader's "eventual consistency" + "aggregate under load" checks
// locally, with explicit PASS/FAIL against the spec's stated thresholds:
//   - newly ingested data must be queryable within 20 seconds
//   - GET /logs/aggregate must return in under 1 second at p95
//
// How it works:
//   - N background workers continuously POST random batches (creates real
//     write pressure, like the grader's ingestion load).
//   - Once per second, a separate "probe" log is sent with a unique
//     attribute (probe_id). Immediately after it's accepted, the script
//     polls GET /logs?attr.probe_id=... every 250ms until it appears or
//     20 seconds pass. That measured delay IS the "time to queryable"
//     the eventual-consistency check cares about.
//   - GET /logs/aggregate is called once per second throughout, same as
//     the grader's stated "one aggregation request per second during the
//     ingestion test".
//
// Requires Node 18+. Run with:
//   node consistency-test.mjs [durationSeconds] [bgConcurrency] [batchSize]
//
// Example:
//   node consistency-test.mjs 60 50 33

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const DURATION_S = Number(process.argv[2] ?? 60);
const BG_CONCURRENCY = Number(process.argv[3] ?? 50);
const BATCH_SIZE = Number(process.argv[4] ?? 33);
const MAX_WAIT_MS = 20000;      // spec: "queryable within 20 seconds"
const AGG_TARGET_MS = 1000;     // spec: "aggregate under 1s at p95"
const PROBE_INTERVAL_MS = 1000; // spec: "one aggregation request per second" -- probes at the same cadence
const POLL_INTERVAL_MS = 250;

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

function probeBatch(probeId) {
  return {
    logs: [
      {
        timestamp: new Date().toISOString(),
        level: "info",
        service: "consistency-probe",
        message: "probe marker",
        attributes: { probe_id: probeId },
      },
    ],
  };
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

async function bgIngestWorker(stopAt, stats) {
  while (Date.now() < stopAt) {
    const start = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(randomBatch(BATCH_SIZE)),
      });
      const elapsed = performance.now() - start;
      const json = await res.json().catch(() => null);
      stats.requests++;
      stats.latencies.push(elapsed);
      if (res.status === 200 && json) {
        stats.accepted += json.accepted ?? 0;
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

async function checkVisible(probeId) {
  const url = `${BASE_URL}/logs?attr.probe_id=${encodeURIComponent(probeId)}&limit=5`;
  try {
    const res = await fetch(url);
    if (res.status !== 200) return false;
    const json = await res.json().catch(() => null);
    return !!json && Array.isArray(json.logs) && json.logs.length > 0;
  } catch {
    return false;
  }
}

async function probeLoop(stopAt, stats) {
  let i = 0;
  while (Date.now() < stopAt) {
    const probeId = `probe-${Date.now()}-${i++}`;
    const loopStart = performance.now();

    let acked = false;
    try {
      const res = await fetch(`${BASE_URL}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(probeBatch(probeId)),
      });
      acked = res.status === 200;
    } catch {
      acked = false;
    }
    const ackTime = performance.now();
    stats.sent++;

    if (!acked) {
      stats.sendFailed++;
    } else {
      let visible = false;
      const pollDeadline = ackTime + MAX_WAIT_MS;
      while (performance.now() < pollDeadline) {
        if (await checkVisible(probeId)) {
          visible = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      const visibleTime = performance.now();

      if (visible) {
        stats.succeeded++;
        stats.timeToQueryableMs.push(visibleTime - ackTime);
      } else {
        stats.timedOut++;
      }
    }

    const elapsed = performance.now() - loopStart;
    await new Promise((r) => setTimeout(r, Math.max(0, PROBE_INTERVAL_MS - elapsed)));
  }
}

async function main() {
  await waitForHealth();
  console.log(
    `Service healthy. Running ${DURATION_S}s: bg ingestion concurrency=${BG_CONCURRENCY}, ` +
      `batchSize=${BATCH_SIZE}, probe+aggregate every ${PROBE_INTERVAL_MS}ms\n`
  );

  const stopAt = Date.now() + DURATION_S * 1000;
  const ingestStats = { requests: 0, accepted: 0, errors: 0, latencies: [] };
  const aggStats = { requests: 0, errors: 0, latencies: [] };
  const probeStats = { sent: 0, succeeded: 0, sendFailed: 0, timedOut: 0, timeToQueryableMs: [] };

  const workers = [];
  for (let i = 0; i < BG_CONCURRENCY; i++) workers.push(bgIngestWorker(stopAt, ingestStats));
  workers.push(aggregateWorker(stopAt, aggStats));
  workers.push(probeLoop(stopAt, probeStats));

  await Promise.all(workers);

  const sortedIngest = ingestStats.latencies.slice().sort((a, b) => a - b);
  const sortedAgg = aggStats.latencies.slice().sort((a, b) => a - b);
  const sortedProbe = probeStats.timeToQueryableMs.slice().sort((a, b) => a - b);

  console.log("=== BACKGROUND INGEST (POST /logs) ===");
  console.log(`Requests: ${ingestStats.requests}, Errors: ${ingestStats.errors}`);
  console.log(`Accepted logs: ${ingestStats.accepted}`);
  console.log(`Throughput: ${(ingestStats.accepted / DURATION_S).toFixed(1)} logs/sec`);
  console.log(
    `Latency  p50: ${percentile(sortedIngest, 50).toFixed(0)}ms  ` +
      `p95: ${percentile(sortedIngest, 95).toFixed(0)}ms  ` +
      `p99: ${percentile(sortedIngest, 99).toFixed(0)}ms`
  );

  console.log("\n=== AGGREGATE (GET /logs/aggregate, 1/sec) ===");
  const aggP95 = percentile(sortedAgg, 95);
  console.log(`Requests: ${aggStats.requests}, Errors: ${aggStats.errors}`);
  console.log(
    `Latency  p50: ${percentile(sortedAgg, 50).toFixed(0)}ms  ` +
      `p95: ${aggP95.toFixed(0)}ms  ` +
      `p99: ${percentile(sortedAgg, 99).toFixed(0)}ms`
  );
  console.log(
    `SPEC CHECK (aggregate p95 < ${AGG_TARGET_MS}ms): ` +
      (aggP95 < AGG_TARGET_MS ? "PASS" : `FAIL (${(aggP95 - AGG_TARGET_MS).toFixed(0)}ms over target)`)
  );

  console.log("\n=== READ-AFTER-WRITE / EVENTUAL CONSISTENCY ===");
  console.log(
    `Probes sent: ${probeStats.sent}, Send failed: ${probeStats.sendFailed}, ` +
      `Timed out (>${MAX_WAIT_MS}ms): ${probeStats.timedOut}`
  );
  const successRate = probeStats.sent > 0 ? (probeStats.succeeded / probeStats.sent) * 100 : 0;
  console.log(`Became queryable: ${probeStats.succeeded}/${probeStats.sent} (${successRate.toFixed(1)}%)`);
  console.log(
    `Time-to-queryable  p50: ${percentile(sortedProbe, 50).toFixed(0)}ms  ` +
      `p95: ${percentile(sortedProbe, 95).toFixed(0)}ms  ` +
      `max: ${sortedProbe.length ? sortedProbe[sortedProbe.length - 1].toFixed(0) : 0}ms`
  );
  console.log(
    `SPEC CHECK (queryable within ${MAX_WAIT_MS}ms): ` +
      (probeStats.timedOut === 0 && probeStats.sendFailed === 0
        ? "PASS"
        : `FAIL (${probeStats.timedOut + probeStats.sendFailed} probe(s) missed the window)`)
  );
}

main();
