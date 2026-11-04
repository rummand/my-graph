ALTER TYPE "public"."graph_kind" ADD VALUE 'practice';--> statement-breakpoint
CREATE TABLE "clinical_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"client_node_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"client_node_id" uuid NOT NULL,
	"clinician_id" uuid NOT NULL,
	"document_source_id" uuid,
	"purposes" text[] DEFAULT '{}' NOT NULL,
	"shared_with" uuid[] DEFAULT '{}' NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"review_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_note" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_item_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"client_node_id" uuid NOT NULL,
	"session_id" uuid,
	"clinician_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"purpose" text DEFAULT 'notes' NOT NULL,
	"title" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"value" real,
	"unit" text,
	"ref_low" real,
	"ref_high" real,
	"measured_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"model" text,
	"change_set_id" uuid,
	"artifact_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"client_node_id" uuid NOT NULL,
	"clinician_id" uuid NOT NULL,
	"node_id" uuid,
	"discipline" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"language" text DEFAULT 'da' NOT NULL,
	"audio_source_id" uuid,
	"transcript_source_id" uuid,
	"work" text DEFAULT 'idle' NOT NULL,
	"work_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_consent_events" ADD CONSTRAINT "clinical_consent_events_consent_id_clinical_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."clinical_consents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_consent_events" ADD CONSTRAINT "clinical_consent_events_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_consents" ADD CONSTRAINT "clinical_consents_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_consents" ADD CONSTRAINT "clinical_consents_client_node_id_nodes_id_fk" FOREIGN KEY ("client_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_consents" ADD CONSTRAINT "clinical_consents_clinician_id_users_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_consents" ADD CONSTRAINT "clinical_consents_document_source_id_sources_id_fk" FOREIGN KEY ("document_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_item_revisions" ADD CONSTRAINT "clinical_item_revisions_item_id_clinical_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."clinical_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_items" ADD CONSTRAINT "clinical_items_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_items" ADD CONSTRAINT "clinical_items_client_node_id_nodes_id_fk" FOREIGN KEY ("client_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_items" ADD CONSTRAINT "clinical_items_session_id_clinical_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_items" ADD CONSTRAINT "clinical_items_clinician_id_users_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_client_node_id_nodes_id_fk" FOREIGN KEY ("client_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_clinician_id_users_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_audio_source_id_sources_id_fk" FOREIGN KEY ("audio_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_transcript_source_id_sources_id_fk" FOREIGN KEY ("transcript_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_consent_events_client_idx" ON "clinical_consent_events" USING btree ("graph_id","client_node_id","at");--> statement-breakpoint
CREATE INDEX "clinical_consents_client_idx" ON "clinical_consents" USING btree ("graph_id","client_node_id");--> statement-breakpoint
CREATE INDEX "clinical_item_revisions_item_idx" ON "clinical_item_revisions" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX "clinical_items_client_idx" ON "clinical_items" USING btree ("graph_id","client_node_id","kind");--> statement-breakpoint
CREATE INDEX "clinical_items_session_idx" ON "clinical_items" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "clinical_sessions_client_idx" ON "clinical_sessions" USING btree ("graph_id","client_node_id","starts_at");--> statement-breakpoint
CREATE INDEX "clinical_sessions_clinician_idx" ON "clinical_sessions" USING btree ("clinician_id","starts_at");