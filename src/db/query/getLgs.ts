import { desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { logs } from "../schema.js";


export async function getLogs(
    limit : number = 100,
    service?:string
){

    const ans = await db
    .select()
    .from(logs)
    .where(service?eq(logs.service,service) : undefined)
    .orderBy(desc(logs.timestamp),desc(logs.id))
    .limit(limit);

    return ans;
}