CREATE TABLE "authentication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"session_id" uuid,
	"event_type" text NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentication_events_type_check" CHECK ("authentication_events"."event_type" IN ('auth.login_succeeded','auth.login_failed','auth.logout','auth.session_revoked','auth.sessions_revoked','auth.session_rotated')),
	CONSTRAINT "authentication_events_subject_check" CHECK ("authentication_events"."event_type" = 'auth.login_failed' OR "authentication_events"."user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" text NOT NULL,
	"device_label" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "browser_sessions_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "browser_sessions_digest_check" CHECK ("browser_sessions"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "browser_sessions_expiry_check" CHECK (isfinite("browser_sessions"."expires_at") AND "browser_sessions"."expires_at" > "browser_sessions"."created_at"),
	CONSTRAINT "browser_sessions_device_check" CHECK ("browser_sessions"."device_label" IN ('Chromium','Firefox','Safari','Other'))
);
--> statement-breakpoint
ALTER TABLE "authentication_events" ADD CONSTRAINT "authentication_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_events" ADD CONSTRAINT "authentication_events_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentication_events_user_idx" ON "authentication_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "browser_sessions_user_idx" ON "browser_sessions" USING btree ("user_id","created_at");