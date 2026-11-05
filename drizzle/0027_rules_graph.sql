CREATE TABLE "corpus_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"parent_key" text,
	"chapter" text,
	"idx" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"page" integer,
	"hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"reread_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corpora" ADD COLUMN "start_url" text;--> statement-breakpoint
ALTER TABLE "corpora" ADD COLUMN "work" jsonb;--> statement-breakpoint
ALTER TABLE "corpora" ADD COLUMN "understanding" jsonb;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "kind" text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "unit_key" text;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "chapter" text;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "pass" integer;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "interpretation" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_rules" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "corpus_units" ADD CONSTRAINT "corpus_units_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_units" ADD CONSTRAINT "corpus_units_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_units" ADD CONSTRAINT "corpus_units_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_units_uq" ON "corpus_units" USING btree ("corpus_id","source_id","key");--> statement-breakpoint
CREATE INDEX "corpus_units_corpus_idx" ON "corpus_units" USING btree ("corpus_id","status");--> statement-breakpoint
-- "Corpora" are "rule sets" now: the built-in kind and the nodes that carry it get the new key (labels refresh from code).
UPDATE "meta_kinds" SET "key" = 'rule_set' WHERE "household_id" IS NULL AND "node_type" = 'document' AND "key" = 'corpus' AND NOT EXISTS (SELECT 1 FROM "meta_kinds" k WHERE k."household_id" IS NULL AND k."node_type" = 'document' AND k."key" = 'rule_set');--> statement-breakpoint
UPDATE "meta_attributes" SET "kind_key" = 'rule_set' WHERE "household_id" IS NULL AND "node_type" = 'document' AND "kind_key" = 'corpus';--> statement-breakpoint
UPDATE "nodes" SET "kind" = 'rule_set' WHERE "type" = 'document' AND "kind" = 'corpus';
--> statement-breakpoint
UPDATE "corpora" SET "kind" = CASE "kind" WHEN 'legislation' THEN 'law' WHEN 'regulation' THEN 'law' WHEN 'standard' THEN 'guidelines' ELSE 'own_rules' END WHERE "kind" IN ('legislation', 'regulation', 'internal_governance', 'guardrail', 'policy', 'standard', 'other');
