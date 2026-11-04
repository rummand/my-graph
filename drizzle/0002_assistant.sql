CREATE TYPE "public"."memory_kind" AS ENUM('preference', 'rule', 'fact', 'note');--> statement-breakpoint
CREATE TYPE "public"."memory_origin" AS ENUM('chat', 'upload', 'external', 'manual', 'automation');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'pending', 'paused');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."suggestion_kind" AS ENUM('fact', 'reminder', 'merge', 'rule', 'memory', 'wiki_edit', 'nudge');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."trigger_kind" AS ENUM('schedule', 'condition', 'heartbeat');--> statement-breakpoint
CREATE TABLE "assistant_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"run_id" uuid,
	"conversation_id" uuid,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"auto_save_memories" boolean DEFAULT true NOT NULL,
	"always_allow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tone" text DEFAULT 'warm' NOT NULL,
	"daily_suggestion_cap" integer DEFAULT 5 NOT NULL,
	"onboarded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" text,
	"output" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"recipe_id" uuid,
	"trigger" "trigger_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"one_shot" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"text" text NOT NULL,
	"about_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" "memory_origin" NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"source_id" uuid,
	"run_id" uuid,
	"quote" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_by_kind" "author_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "suggestion_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"run_id" uuid,
	"conversation_id" uuid,
	"dedupe_key" text,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "unread_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "sensitivity" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_up_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thought_ms" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "clarify" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "feedback" integer;--> statement-breakpoint
ALTER TABLE "assistant_activity" ADD CONSTRAINT "assistant_activity_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_activity" ADD CONSTRAINT "assistant_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_activity_graph_idx" ON "assistant_activity" USING btree ("graph_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_settings_graph_user_uq" ON "assistant_settings" USING btree ("graph_id","user_id");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("automation_id","started_at");--> statement-breakpoint
CREATE INDEX "automations_due_idx" ON "automations" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "automations_graph_idx" ON "automations" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "memories_graph_idx" ON "memories" USING btree ("graph_id","status");--> statement-breakpoint
CREATE INDEX "recipes_graph_idx" ON "recipes" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "suggestions_inbox_idx" ON "suggestions" USING btree ("graph_id","user_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_dedupe_idx" ON "suggestions" USING btree ("graph_id","dedupe_key");