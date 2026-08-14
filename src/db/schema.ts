


import { sql } from "drizzle-orm";
import { pgTable,index, uuid,text,timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const levelEnum = pgEnum("level",["debug","info","warn","error"]);

export const logs = pgTable("logs",{

    id : uuid("id").primaryKey().defaultRandom(),
    timestamp : timestamp("timestamp", { withTimezone: true }).notNull(),
    level : levelEnum("level").notNull(),
    service:text("service").notNull(),
    message:text("message").notNull(),
    attributes: jsonb("attributes").default(sql`{}::jsonb`).notNull()
},(t)=>({
    // define the GIN index for the attributes
    attributesInx : index("attributes_ginIndex").using("gin",t.attributes),

    timestampIdIdx: index("timestamp_id_idx").on(t.timestamp.desc(), t.id.desc()),

    serviceTimestampIdx: index("service_timestamp_id_idx").on(t.service, t.timestamp.desc(), t.id.desc(),t.level),

        messageIndex: index("messageindex").using("gin", sql`message gin_trgm_ops`),
}));

export type newLog = typeof logs.$inferInsert;