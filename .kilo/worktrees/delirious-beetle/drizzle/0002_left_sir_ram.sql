CREATE TABLE "usage_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_items" ADD COLUMN "ip_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "history_items" ADD COLUMN "result" jsonb;