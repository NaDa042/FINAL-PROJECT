
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";
import { MigrationConfig } from "drizzle-orm/migrator";



if (!process.env.DATABASE_URL) {
  throw new Error("Database URL is not configured.");
}

export const writeConn = postgres(process.env.DATABASE_URL,{max:20});
export const readConn = postgres(process.env.DATABASE_URL,{max:10});


export const db = drizzle(writeConn, {schema}); // ingestion
export const readDb = drizzle(readConn,{schema});// query + aggregate



const migrationConfig : MigrationConfig = {
    migrationsFolder : "./src/db/migrations",
};
