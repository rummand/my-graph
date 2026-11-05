CREATE TABLE "route_timings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"route" text NOT NULL,
	"method" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"slow" integer DEFAULT 0 NOT NULL,
	"sum_ms" integer DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL,
	"hist" integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"stack_hash" text NOT NULL,
	"frames" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"route" text NOT NULL,
	"method" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'request' NOT NULL,
	"status" integer,
	"digest" text,
	"count" integer DEFAULT 0 NOT NULL,
	"user_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_duration_ms" integer,
	"max_duration_ms" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_timings_bucket_route_uq" ON "route_timings" USING btree ("bucket","route","method");--> statement-breakpoint
CREATE INDEX "route_timings_bucket_idx" ON "route_timings" USING btree ("bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "server_errors_fingerprint_uq" ON "server_errors" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "server_errors_last_seen_idx" ON "server_errors" USING btree ("last_seen_at");