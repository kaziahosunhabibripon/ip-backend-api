CREATE TABLE "lookup_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"status" text NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"latency" jsonb
);
--> statement-breakpoint
ALTER TABLE "lookup_events" ADD CONSTRAINT "lookup_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lookup_events_user_id_at_idx" ON "lookup_events" USING btree ("user_id","at");