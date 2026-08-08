

import { db } from "../index.js";
import { logs} from "../schema.js";
import type { newLog } from "../schema.js";

export async function insertLogs(log:newLog[]){
    await db
    .insert(logs)
    .values(log);
}