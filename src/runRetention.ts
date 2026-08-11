
import {deleteExpiredBatch} from "./db/query/expired.js"


export async function runRetention(cutoff: Date, batchSize: number) {
    let num: number;
    // we used do while to avoid repeated calls for the query when usong normal while loop
    do {
        num = await deleteExpiredBatch(cutoff, batchSize);
    } while (num > 0);
}