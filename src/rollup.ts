// rollup.ts
// In-memory rolling pre-aggregation for GET /logs/aggregate.
//
// Why: under heavy concurrent ingestion, Postgres's single CPU core has to
// split time between writing new rows and executing aggregate queries.
// Even though the aggregate query itself runs in ~20ms in isolation, under
// load it can queue for seconds waiting for a CPU scheduling turn.
//
// This keeps a live, in-process count of logs per (minute bucket, service,
// level) as they're ingested. For the common case -- a recent window, no
// attr/q filter -- GET /logs/aggregate is served entirely from this
// in-memory structure: zero Postgres round trips, so it's immune to
// write-path contention.
//
//
// Single-process assumption: this is correct as long as one app instance
// handles all ingestion and all queries (true for this deployment's 0.5
// CPU / 256MB single container). If you ever scale to multiple app
// replicas, this would need to move to a shared store (e.g. Redis) --
// worth a line in the README's known limitations either way.

type Level = "debug" | "info" | "warn" | "error";

const RETAIN_MINUTES = 180; // how far back the cache stays valid; tune to container memory budget

const buckets = new Map<number, Map<string, number>>();

function secondEpoch(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export function recordIngested(entries: { timestamp: Date; service: string; level: Level }[]) {
  for (const e of entries) {
    const m = secondEpoch(e.timestamp);
    let cell = buckets.get(m);
    if (!cell) {
      cell = new Map();
      buckets.set(m, cell);
    }
    const key = `${e.service}|${e.level}`;
    cell.set(key, (cell.get(key) ?? 0) + 1);
  }
}

// Periodic trim so memory doesn't grow unbounded across a long-running process.
setInterval(() => {
  const cutoff = secondEpoch(new Date()) - RETAIN_MINUTES * 60;
  for (const m of buckets.keys()) {
    if (m < cutoff) buckets.delete(m);
  }
}, 60_000).unref();

export type RollupParams = {
  since: Date;
  until: Date;
  bucketSeconds: number;
  service?: string;
  level?: Level;
  hasAttrFilter: boolean;
  hasMessageFilter: boolean;
  groupBy?: "service" | "level";
};

export function canServeFromRollup(p: RollupParams): boolean {
  if (p.hasAttrFilter || p.hasMessageFilter) return false; // not tracked in-memory, must hit Postgres
  const oldestTracked = secondEpoch(new Date()) - RETAIN_MINUTES * 60;
  if (secondEpoch(p.since) < oldestTracked) return false; // window predates what we retain
  return true;
}

export function queryRollup(
  p: RollupParams
): { start: string; group: string | null; count: number }[] {
  const sinceS = secondEpoch(p.since);
  const untilS = secondEpoch(p.until);

  // groupKey -> bucketStartSeconds -> count
  const out = new Map<string, Map<number, number>>();

  for (const [sec, cell] of buckets) {
    if (sec < sinceS || sec >= untilS) continue;
    const bucketStart = Math.floor(sec / p.bucketSeconds) * p.bucketSeconds;

    for (const [key, count] of cell) {
      const [service, level] = key.split("|");
      if (p.service && service !== p.service) continue;
      if (p.level && level !== p.level) continue;

      const groupKey = p.groupBy === "service" ? service : p.groupBy === "level" ? level : "__all__";
      let byBucket = out.get(groupKey);
      if (!byBucket) {
        byBucket = new Map();
        out.set(groupKey, byBucket);
      }
      byBucket.set(bucketStart, (byBucket.get(bucketStart) ?? 0) + count);
    }
  }

  const rows: { start: string; group: string | null; count: number }[] = [];
  for (const [groupKey, byBucket] of out) {
    for (const [bucketStart, count] of byBucket) {
      rows.push({
        start: new Date(bucketStart * 1000).toISOString(),
        group: groupKey === "__all__" ? null : groupKey,
        count,
      });
    }
  }
  rows.sort((a, b) => a.start.localeCompare(b.start) || (a.group ?? "").localeCompare(b.group ?? ""));
  return rows;
}
