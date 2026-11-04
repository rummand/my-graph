CREATE TABLE "profile_doc_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"event" text DEFAULT 'saved' NOT NULL,
	"based_on" integer,
	"author_kind" text DEFAULT 'person' NOT NULL,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"doc" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"model" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_doc_versions" ADD CONSTRAINT "profile_doc_versions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_doc_versions" ADD CONSTRAINT "profile_doc_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_docs" ADD CONSTRAINT "profile_docs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_docs" ADD CONSTRAINT "profile_docs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_insights" ADD CONSTRAINT "profile_insights_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_insights" ADD CONSTRAINT "profile_insights_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_insights" ADD CONSTRAINT "profile_insights_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_doc_versions_node_idx" ON "profile_doc_versions" USING btree ("graph_id","node_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_docs_node_uq" ON "profile_docs" USING btree ("graph_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_insights_viewer_uq" ON "profile_insights" USING btree ("graph_id","node_id","viewer_id");