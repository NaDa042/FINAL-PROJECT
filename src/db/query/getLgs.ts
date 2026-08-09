import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { logs } from "../schema.js";
import z from "zod";

export async function getLogs(
    limit : number = 100,
    service?:string,
    level?: "debug" | "info" | "warn" | "error"
){

    const ans = await db
    .select()
    .from(logs)
    .where(and(
        service?eq(logs.service,service) : undefined,
        level?eq(logs.level,level):undefined
    ))
    .orderBy(desc(logs.timestamp),desc(logs.id))
    .limit(limit);

    return ans;
}