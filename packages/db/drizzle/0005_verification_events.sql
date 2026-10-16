CREATE TABLE "verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text DEFAULT 'identity.email_verification_requested' NOT NULL,
	"reason" text DEFAULT 'signup' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_events_type_check" CHECK ("verification_events"."event_type" = 'identity.email_verification_requested'),
	CONSTRAINT "verification_events_reason_check" CHECK ("verification_events"."reason" IN ('signup', 'resend'))
);
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_events_initial_user_unique" ON "verification_events" USING btree ("user_id") WHERE "verification_events"."reason" = 'signup';--> statement-breakpoint
CREATE INDEX "verification_events_created_idx" ON "verification_events" USING btree ("created_at","id");