CREATE TABLE "signup_idempotency_namespace" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"hmac_key_version" integer NOT NULL,
	"attestation_key_digest" varchar(64) NOT NULL,
	"attestation_payload_digest" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_namespace_singleton_check" CHECK ("signup_idempotency_namespace"."id" = 1),
	CONSTRAINT "signup_namespace_version_check" CHECK ("signup_idempotency_namespace"."hmac_key_version" > 0),
	CONSTRAINT "signup_namespace_digests_check" CHECK ("signup_idempotency_namespace"."attestation_key_digest" ~ '^[0-9a-f]{64}$' AND "signup_idempotency_namespace"."attestation_payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signup_namespace_created_check" CHECK (isfinite("signup_idempotency_namespace"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "signup_idempotency_terminal_events" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"policy_version" integer NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"recorded_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "signup_terminal_events_policy_check" CHECK ("signup_idempotency_terminal_events"."policy_version" = 1 AND "signup_idempotency_terminal_events"."event_type" = 'signup.expired'),
	CONSTRAINT "signup_terminal_events_time_check" CHECK (isfinite("signup_idempotency_terminal_events"."observed_at") AND isfinite("signup_idempotency_terminal_events"."recorded_at"))
);
--> statement-breakpoint
ALTER TABLE "signup_idempotency_terminal_events" ADD CONSTRAINT "signup_terminal_events_claim_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."signup_idempotency_claims"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "signup_claims_hmac_version_idx" ON "signup_idempotency_claims" USING btree ("hmac_key_version");