CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"user_id" text NOT NULL,
	"plan" "plan" NOT NULL,
	"billing_cycle" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"list_price_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway_invoice_no" text NOT NULL,
	"checkout_url" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp,
	"applied_at" timestamp,
	"next_poll_at" timestamp DEFAULT now() NOT NULL,
	"poll_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "queued_plan" "plan";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "queued_cycle" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "reminded_week_for" timestamp;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "reminded_day_for" timestamp;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "expiry_notified_for" timestamp;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_invoice_no_idx" ON "payments" USING btree ("gateway_invoice_no");--> statement-breakpoint
CREATE INDEX "payments_user_id_created_at_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_next_poll_at_idx" ON "payments" USING btree ("status","next_poll_at");