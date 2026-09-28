ALTER TABLE "alerts" DROP CONSTRAINT "alerts_monitor_id_monitors_id_fk";
--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "monitor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "schedule" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "status" SET DEFAULT 'healthy';--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "target" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "message" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "summary" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "watch" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "target_type" text DEFAULT 'domain' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "interval_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "watch" jsonb DEFAULT '["dns","ip","provider","security"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_emailed_at" timestamp;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_user_id_created_at_idx" ON "alerts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_monitor_id_idx" ON "alerts" USING btree ("monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_user_id_target_idx" ON "monitors" USING btree ("user_id","target");--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("enabled","next_check_at");