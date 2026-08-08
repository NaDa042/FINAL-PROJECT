
import { conn, db } from "../index.js";
import { logs } from "../schema.js";


export async function checkConnection() {
    await conn`SELECT 1`;
}

export async function checkMigrations() {
    await db.select().from(logs).limit(1); 
}