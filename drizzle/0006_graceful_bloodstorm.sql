ALTER TABLE "api_keys" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_secret_hash_idx" ON "api_keys" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_created_at_idx" ON "api_keys" USING btree ("user_id","created_at");