CREATE TABLE "signup_idempotency_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_version" integer NOT NULL,
	"hmac_key_version" integer NOT NULL,
	"key_digest" varchar(64) NOT NULL,
	"payload_version" integer NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"lock_anchor" boolean DEFAULT false NOT NULL,
	CONSTRAINT "signup_idempotency_claims_key_unique" UNIQUE("key_version","hmac_key_version","key_digest"),
	CONSTRAINT "signup_idempotency_claims_versions_check" CHECK ("signup_idempotency_claims"."key_version" = 1 AND "signup_idempotency_claims"."payload_version" = 1 AND "signup_idempotency_claims"."hmac_key_version" > 0),
	CONSTRAINT "signup_idempotency_claims_digests_check" CHECK ("signup_idempotency_claims"."key_digest" ~ '^[0-9a-f]{64}$' AND "signup_idempotency_claims"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "signup_idempotency_claims_expiry_check" CHECK (isfinite("signup_idempotency_claims"."created_at") AND isfinite("signup_idempotency_claims"."expires_at") AND "signup_idempotency_claims"."expires_at" > "signup_idempotency_claims"."created_at"),
	CONSTRAINT "signup_idempotency_claims_lock_anchor_check" CHECK ("signup_idempotency_claims"."lock_anchor" = false)
);
--> statement-breakpoint
CREATE TABLE "signup_idempotency_results" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"result_version" integer NOT NULL,
	"status_code" smallint NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_idempotency_results_response_check" CHECK ("signup_idempotency_results"."result_version" = 1 AND "signup_idempotency_results"."status_code" = 202 AND "signup_idempotency_results"."response_body" = '{"status":"accepted"}'::jsonb),
	CONSTRAINT "signup_idempotency_results_created_at_check" CHECK (isfinite("signup_idempotency_results"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "signup_idempotency_results" ADD CONSTRAINT "signup_idempotency_results_claim_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."signup_idempotency_claims"("id") ON DELETE restrict ON UPDATE restrict;
