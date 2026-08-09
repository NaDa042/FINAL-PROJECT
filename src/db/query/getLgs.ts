import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "../index.js";
import { logs } from "../schema.js";

export async function getLogs(
    limit : number = 100,
    service?:string,
    level?: "debug" | "info" | "warn" | "error",
    since?: Date,
    until?: Date,
){

    const ans = await db
    .select()
    .from(logs)
    .where(and(
        service?eq(logs.service,service) : undefined,
        level?eq(logs.level,level):undefined,
        since? gte(logs.timestamp,since):undefined, // incluseve >=
        until? lt(logs.timestamp,until):undefined // exclusive <
    ))
    .orderBy(desc(logs.timestamp),desc(logs.id))
    .limit(limit);

    return ans;
}