import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { readDb } from "../index.js";
import { logs } from "../schema.js";

export async function getLogs(
    limit : number,
    service?:string,
    level?: "debug" | "info" | "warn" | "error",
    since?: Date,
    until?: Date,
    attr?: Record<string,string>,
    q? : string,
    cursor? : {timestamp:Date,id:string}
){

    const attrConditions = attr
    ? Object.entries(attr).map(([key, value]) =>
        sql`${logs.attributes} @> ${JSON.stringify({ [key]: value })}::jsonb`
        )
    : [];
    const ans = await readDb
    .select()
    .from(logs)
    .where(and(
        service?eq(logs.service,service) : undefined,
        level?eq(logs.level,level):undefined,
        since? gte(logs.timestamp,since):undefined, // incluseve >=
        until? lt(logs.timestamp,until):undefined, // exclusive <
        ...attrConditions,
        q? ilike(logs.message,`%${q}%`) : undefined, // ilike is case-insensitive
        cursor? or(lt(logs.timestamp,cursor.timestamp),and(eq(logs.timestamp,cursor.timestamp),lt(logs.id,cursor.id))) : undefined
    ))
    .orderBy(desc(logs.timestamp),desc(logs.id))
    .limit(limit+1);

    return ans;
}