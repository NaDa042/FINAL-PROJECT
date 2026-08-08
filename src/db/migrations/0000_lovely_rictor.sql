CREATE TYPE "public"."level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"level" "level" NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb
);
--> statement-breakpoint
CREATE INDEX "attributes_ginIndex" ON "logs" USING gin ("attributes");