CREATE TABLE "abuse_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_label" text NOT NULL,
	"reason" text NOT NULL,
	"severity" text NOT NULL,
	"events" integer NOT NULL,
	"events_at_decision" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" jsonb,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_visitors" (
	"visitor_hash" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"blocked_by" text,
	"blocked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"plan" "plan" NOT NULL,
	"from_plan" "plan",
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_visitors" ADD CONSTRAINT "blocked_visitors_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_flags_subject_reason_idx" ON "abuse_flags" USING btree ("kind","subject_key","reason");--> statement-breakpoint
CREATE INDEX "abuse_flags_status_last_seen_idx" ON "abuse_flags" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "subscription_events_at_idx" ON "subscription_events" USING btree ("at");