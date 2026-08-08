
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";
import { MigrationConfig } from "drizzle-orm/migrator";



if (!process.env.DATABASE_URL) {
  throw new Error("Database URL is not configured.");
}

export const conn = postgres(process.env.DATABASE_URL);
export const db = drizzle(conn, {schema});



const migrationConfig : MigrationConfig = {
    migrationsFolder : "./src/db/migrations",
};
