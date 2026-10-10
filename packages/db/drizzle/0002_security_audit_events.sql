CREATE TABLE "security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"user_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "security_audit_events_type_user_unique" UNIQUE("event_type","user_id"),
	CONSTRAINT "security_audit_events_type_check" CHECK ("security_audit_events"."event_type" = 'identity.user_created'),
	CONSTRAINT "security_audit_events_payload_check" CHECK ("security_audit_events"."payload" = '{}'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "security_audit_events" ADD CONSTRAINT "security_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;