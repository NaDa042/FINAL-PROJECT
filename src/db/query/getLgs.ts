import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../index.js";
import { logs } from "../schema.js";

export async function getLogs(
    limit : number = 100,
    service?:string,
    level?: "debug" | "info" | "warn" | "error",
    since?: Date,
    until?: Date,
    attr?: Record<string,string>
){

    const attrConditions = attr?
        Object.entries(attr).map(([key,value])=>
        sql`${logs.attributes} @> ${JSON.stringify({[key]:value})}::jsonb`
    ):[];

    const ans = await db
    .select()
    .from(logs)
    .where(and(
        service?eq(logs.service,service) : undefined,
        level?eq(logs.level,level):undefined,
        since? gte(logs.timestamp,since):undefined, // incluseve >=
        until? lt(logs.timestamp,until):undefined, // exclusive <
        ...attrConditions
    ))
    .orderBy(desc(logs.timestamp),desc(logs.id))
    .limit(limit);

    return ans;
}