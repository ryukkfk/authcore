CREATE TABLE "account_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_security_events_type_check" CHECK ("account_security_events"."event_type" = 'identity.email_verified')
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"owner" uuid,
	"locked_until" timestamp (3) with time zone,
	"envelope" jsonb,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_status_check" CHECK ("email_deliveries"."status" IN ('pending','processing','sent','dead','cancelled')),
	CONSTRAINT "email_deliveries_attempts_check" CHECK ("email_deliveries"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "email_deliveries_lease_check" CHECK (("email_deliveries"."status" = 'processing' AND "email_deliveries"."owner" IS NOT NULL AND "email_deliveries"."locked_until" IS NOT NULL) OR ("email_deliveries"."status" <> 'processing' AND "email_deliveries"."owner" IS NULL AND "email_deliveries"."locked_until" IS NULL)),
	CONSTRAINT "email_deliveries_terminal_check" CHECK ("email_deliveries"."status" NOT IN ('sent','dead','cancelled') OR "email_deliveries"."envelope" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "email_delivery_attempts" (
	"event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"phase" text NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_delivery_attempts_event_id_attempt_phase_pk" PRIMARY KEY("event_id","attempt","phase"),
	CONSTRAINT "email_delivery_attempts_number_check" CHECK ("email_delivery_attempts"."attempt" BETWEEN 1 AND 5),
	CONSTRAINT "email_delivery_attempts_phase_check" CHECK ("email_delivery_attempts"."phase" IN ('claimed','sent','retry','dead','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "email_verification_tokens_digest_unique" UNIQUE("digest"),
	CONSTRAINT "email_verification_tokens_digest_check" CHECK ("email_verification_tokens"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_verification_tokens_expiry_check" CHECK (isfinite("email_verification_tokens"."expires_at") AND "email_verification_tokens"."expires_at" > "email_verification_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_event_id_verification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."verification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery_attempts" ADD CONSTRAINT "email_delivery_attempts_event_id_email_deliveries_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."email_deliveries"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_event_id_verification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."verification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_security_events_user_idx" ON "account_security_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_ready_idx" ON "email_deliveries" USING btree ("status","next_attempt_at");
