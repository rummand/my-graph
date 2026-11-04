CREATE TYPE "public"."change_set_status" AS ENUM('draft', 'delivered', 'abandoned');--> statement-breakpoint
ALTER TYPE "public"."graph_kind" ADD VALUE 'partner';--> statement-breakpoint
ALTER TYPE "public"."graph_kind" ADD VALUE 'project';--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'organization';--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'project';--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'thing';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'web';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'connector';--> statement-breakpoint
CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "change_set_status" DEFAULT 'draft' NOT NULL,
	"origin" text NOT NULL,
	"created_by" uuid,
	"for_user_id" uuid,
	"base_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_set_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"node_id" uuid,
	"edge_id" uuid,
	"subject" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"label" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_set_id" uuid,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"status_detail" text,
	"every_minutes" integer DEFAULT 15 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_name" text,
	"kind" text NOT NULL,
	"field" text,
	"from_value" jsonb,
	"to_value" jsonb,
	"from_node_id" uuid,
	"to_node_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"change_set_id" uuid,
	"context" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"in_type" text NOT NULL,
	"in_id" uuid NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_settings" ALTER COLUMN "auto_save_memories" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD COLUMN "change_set_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD COLUMN "change_set_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_relations" ADD COLUMN "change_set_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "document_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "document_date_precision" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "thread_key" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text DEFAULT 'Europe/Copenhagen' NOT NULL;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_runs" ADD CONSTRAINT "connection_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_runs" ADD CONSTRAINT "connection_runs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_events" ADD CONSTRAINT "graph_events_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_sets_graph_idx" ON "change_sets" USING btree ("graph_id","status","created_at");--> statement-breakpoint
CREATE INDEX "changes_set_idx" ON "changes" USING btree ("change_set_id","seq");--> statement-breakpoint
CREATE INDEX "checkpoints_graph_idx" ON "checkpoints" USING btree ("graph_id","at");--> statement-breakpoint
CREATE INDEX "connection_runs_conn_idx" ON "connection_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "connections_due_idx" ON "connections" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "connections_graph_idx" ON "connections" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "graph_events_graph_at_idx" ON "graph_events" USING btree ("graph_id","at");--> statement-breakpoint
CREATE INDEX "graph_events_subject_idx" ON "graph_events" USING btree ("subject_id","at");--> statement-breakpoint
CREATE INDEX "mentions_node_idx" ON "mentions" USING btree ("graph_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_in_uq" ON "mentions" USING btree ("in_type","in_id","node_id");--> statement-breakpoint
CREATE INDEX "sources_thread_idx" ON "sources" USING btree ("graph_id","thread_key");--> statement-breakpoint
CREATE INDEX "sources_docdate_idx" ON "sources" USING btree ("graph_id","document_date");
--> statement-breakpoint
UPDATE "assistant_settings" SET "auto_save_memories" = true;
