CREATE TABLE "bulk_items" (
	"job_id" text NOT NULL,
	"position" integer NOT NULL,
	"input" text NOT NULL,
	"target" text,
	"type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" jsonb,
	"error" jsonb,
	CONSTRAINT "bulk_items_job_id_position_pk" PRIMARY KEY("job_id","position")
);
--> statement-breakpoint
CREATE TABLE "bulk_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"stopped_reason" text,
	"leased_until" timestamp,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bulk_items" ADD CONSTRAINT "bulk_items_job_id_bulk_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."bulk_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_jobs" ADD CONSTRAINT "bulk_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_items_job_id_status_idx" ON "bulk_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "bulk_jobs_user_id_created_at_idx" ON "bulk_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "bulk_jobs_status_idx" ON "bulk_jobs" USING btree ("status");