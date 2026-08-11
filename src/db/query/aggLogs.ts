import { and, eq, gte, ilike, lt, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { logs } from '../schema.js';


export async function aggLogs(
  since: Date,
  until: Date,
  bucket: number,
  service?: string,
  level?: 'debug' | 'info' | 'warn' | 'error',
  attr?: Record<string, string>,
  q?: string,
  group_by?: 'service' | 'level'
) {
    // Build dynamic attribute conditions safely
    const attrConditions = attr
        ? Object.entries(attr).map(([key, value]) =>
            sql`${logs.attributes}->>${key} = ${value}`
        )
        : [];

    const groupByCol =
        group_by === 'service'
        ? logs.service
        : group_by === 'level'
        ? logs.level
        : undefined;

        
    const bucketTime = sql<string>`to_timestamp(floor(extract(epoch from ${logs.timestamp}) / ${bucket})*${bucket})` ;



    let query = db
    .select({
        start:bucketTime,
        group: groupByCol??sql<null>`null`,
        count:sql<number>`count(*)::int`// ::int casts in Postgres (bigint -> integer) so the driver returns a real JS number;
                                        // sql<number> only tells TypeScript the type, it doesn't change what Postgres/driver actually returns
    })
    .from(logs)
    .where(
        and(
            service ? eq(logs.service, service) : undefined,
            level ? eq(logs.level, level) : undefined,
            q ? ilike(logs.message, `%${q}%`) : undefined,
            gte(logs.timestamp, since),
            lt(logs.timestamp, until),
            ...attrConditions
        )
    // group/order by position 1 (bucket) instead of repeating the expression - avoids SQL text mismatch; add groupByCol only if group_by was requested
    ).groupBy(sql`1`,...(groupByCol?[groupByCol]:[]))
    .orderBy(sql`1`)


    const result = await query;
    return result;
}
