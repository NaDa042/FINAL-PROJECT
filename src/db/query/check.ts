
import { writeConn,readConn, db } from "../index.js";
import { logs } from "../schema.js";


export async function checkConnection() {
    await writeConn`SELECT 1`;
    await readConn`SELECT 1`;
}

export async function checkMigrations() {
    await db.select().from(logs).limit(1); 
}