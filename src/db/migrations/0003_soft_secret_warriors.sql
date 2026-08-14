DROP INDEX "service_timestamp_id_idx";--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "attributes" SET DEFAULT {}::jsonb;--> statement-breakpoint
ALTER TABLE "logs" ALTER COLUMN "attributes" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "messageindex" ON "logs" USING gin (message gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "service_timestamp_id_idx" ON "logs" USING btree ("service","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST,"level");