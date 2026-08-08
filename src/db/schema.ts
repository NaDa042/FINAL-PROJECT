


import { pgTable,index, uuid,text,timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const levelEnum = pgEnum("level",["debug","info","warn","error"]);

export const logs = pgTable("logs",{

    id : uuid("id").primaryKey().defaultRandom(),
    timestamp : timestamp("timestamp", { withTimezone: true }).notNull(),
    level : levelEnum("level").notNull(),
    service:text("service").notNull(),
    message:text("message").notNull(),
    attributes: jsonb("attributes")
},(logs)=>({
    // define the GIN index for the attributes
    attributesInx : index("attributes_ginIndex").using("gin",logs.attributes),
}));

export type newLog = typeof logs.$inferInsert;