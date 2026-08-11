

import { inArray, lt } from "drizzle-orm";
import { db } from "../index.js";
import { logs } from "../schema.js";

export async function deleteExpiredBatch(cutoff:Date,batchSize:number){
    const result  = await db
    .delete(logs)
    .where(
        inArray(logs.id,
            db
            .select({id:logs.id})
            .from(logs)
            .where(lt(logs.timestamp,cutoff))
            .limit(batchSize)
        )
    );
    return result.count;
}