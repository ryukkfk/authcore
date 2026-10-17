CREATE TABLE "password_recovery_attempts" (
	"event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"phase" text NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_recovery_attempts_event_id_attempt_phase_pk" PRIMARY KEY("event_id","attempt","phase"),
	CONSTRAINT "password_recovery_attempts_number_check" CHECK ("password_recovery_attempts"."attempt" BETWEEN 1 AND 5),
	CONSTRAINT "password_recovery_attempts_phase_check" CHECK ("password_recovery_attempts"."phase" IN ('claimed','sent','retry','dead','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "password_recovery_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text DEFAULT 'identity.password_reset' NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_recovery_audit_type_check" CHECK ("password_recovery_audit"."event_type" = 'identity.password_reset')
);
--> statement-breakpoint
CREATE TABLE "password_recovery_deliveries" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"owner" uuid,
	"locked_until" timestamp (3) with time zone,
	"envelope" jsonb,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_recovery_deliveries_status_check" CHECK ("password_recovery_deliveries"."status" IN ('pending','processing','sent','dead','cancelled')),
	CONSTRAINT "password_recovery_deliveries_attempts_check" CHECK ("password_recovery_deliveries"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "password_recovery_deliveries_lease_check" CHECK (("password_recovery_deliveries"."status" = 'processing' AND "password_recovery_deliveries"."owner" IS NOT NULL AND "password_recovery_deliveries"."locked_until" IS NOT NULL) OR ("password_recovery_deliveries"."status" <> 'processing' AND "password_recovery_deliveries"."owner" IS NULL AND "password_recovery_deliveries"."locked_until" IS NULL)),
	CONSTRAINT "password_recovery_deliveries_terminal_check" CHECK ("password_recovery_deliveries"."status" NOT IN ('sent','dead','cancelled') OR "password_recovery_deliveries"."envelope" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "password_recovery_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text DEFAULT 'identity.password_recovery_requested' NOT NULL,
	"credential_binding" text NOT NULL,
	"email_binding" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "password_recovery_requests_type_check" CHECK ("password_recovery_requests"."event_type" = 'identity.password_recovery_requested'),
	CONSTRAINT "password_recovery_requests_credential_binding_check" CHECK ("password_recovery_requests"."credential_binding" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "password_recovery_requests_email_binding_check" CHECK ("password_recovery_requests"."email_binding" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "password_recovery_requests_expiry_check" CHECK (isfinite("password_recovery_requests"."expires_at") AND "password_recovery_requests"."expires_at" > "password_recovery_requests"."created_at")
);
--> statement-breakpoint
CREATE TABLE "password_recovery_tokens" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "password_recovery_tokens_digest_unique" UNIQUE("digest"),
	CONSTRAINT "password_recovery_tokens_digest_check" CHECK ("password_recovery_tokens"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "password_recovery_tokens_expiry_check" CHECK (isfinite("password_recovery_tokens"."expires_at") AND "password_recovery_tokens"."expires_at" > "password_recovery_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "password_recovery_attempts" ADD CONSTRAINT "password_recovery_attempts_event_id_password_recovery_deliveries_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."password_recovery_deliveries"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recovery_audit" ADD CONSTRAINT "password_recovery_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recovery_audit" ADD CONSTRAINT "password_recovery_audit_event_id_password_recovery_requests_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."password_recovery_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recovery_deliveries" ADD CONSTRAINT "password_recovery_deliveries_event_id_password_recovery_requests_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."password_recovery_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recovery_requests" ADD CONSTRAINT "password_recovery_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recovery_tokens" ADD CONSTRAINT "password_recovery_tokens_event_id_password_recovery_requests_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."password_recovery_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_recovery_audit_user_idx" ON "password_recovery_audit" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "password_recovery_deliveries_ready_idx" ON "password_recovery_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "password_recovery_requests_user_created_idx" ON "password_recovery_requests" USING btree ("user_id","created_at");