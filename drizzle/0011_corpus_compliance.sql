CREATE TABLE "compliance_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_version" integer,
	"rule_id" uuid NOT NULL,
	"corpus_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"span" jsonb,
	"suggestion" text,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"accepted_reason" text,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"fixed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_version" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"corpus_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules_checked" integer DEFAULT 0 NOT NULL,
	"paragraphs" integer DEFAULT 0 NOT NULL,
	"paragraphs_cached" integer DEFAULT 0 NOT NULL,
	"mux_calls" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ms" integer,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compliance_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text DEFAULT '' NOT NULL,
	"corpus_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpora" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"authority" text,
	"binding" text DEFAULT 'mandatory' NOT NULL,
	"version" text,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope" jsonb DEFAULT '{"all":true}'::jsonb NOT NULL,
	"check_by_default" boolean DEFAULT true NOT NULL,
	"rules_version" integer DEFAULT 1 NOT NULL,
	"read_state" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpus_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"section" text,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"modality" text DEFAULT 'must' NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_hint" text,
	"severity" text DEFAULT 'major' NOT NULL,
	"source_id" uuid,
	"chunk_id" uuid,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote" text,
	"embedding" vector(1024),
	"status" text DEFAULT 'proposed' NOT NULL,
	"change" text,
	"supersedes_id" uuid,
	"corpus_version" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpus_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"role" text DEFAULT 'text' NOT NULL,
	"corpus_version" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_findings" ADD CONSTRAINT "compliance_findings_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_findings" ADD CONSTRAINT "compliance_findings_rule_id_corpus_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."corpus_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_findings" ADD CONSTRAINT "compliance_findings_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_runs" ADD CONSTRAINT "compliance_runs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_targets" ADD CONSTRAINT "compliance_targets_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpora" ADD CONSTRAINT "corpora_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpora" ADD CONSTRAINT "corpora_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD CONSTRAINT "corpus_rules_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD CONSTRAINT "corpus_rules_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD CONSTRAINT "corpus_rules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_sources" ADD CONSTRAINT "corpus_sources_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_sources" ADD CONSTRAINT "corpus_sources_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_sources" ADD CONSTRAINT "corpus_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_findings_target_idx" ON "compliance_findings" USING btree ("graph_id","target_type","target_id","status");--> statement-breakpoint
CREATE INDEX "compliance_runs_target_idx" ON "compliance_runs" USING btree ("graph_id","target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_targets_uq" ON "compliance_targets" USING btree ("graph_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "corpora_graph_idx" ON "corpora" USING btree ("graph_id","status");--> statement-breakpoint
CREATE INDEX "corpus_rules_corpus_idx" ON "corpus_rules" USING btree ("corpus_id","status");--> statement-breakpoint
CREATE INDEX "corpus_rules_graph_idx" ON "corpus_rules" USING btree ("graph_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_sources_uq" ON "corpus_sources" USING btree ("corpus_id","source_id");