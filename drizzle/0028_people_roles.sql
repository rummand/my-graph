CREATE TABLE "meta_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"plural_label" text,
	"preposition" text DEFAULT 'of' NOT NULL,
	"inverse_label" text,
	"label_da" text,
	"plural_label_da" text,
	"preposition_da" text,
	"inverse_label_da" text,
	"description" text,
	"context_types" text[] DEFAULT '{}' NOT NULL,
	"circle" text,
	"implied_by" text,
	"parent_key" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"graph_id" uuid,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone,
	"change_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_roles_graph_key_uq" UNIQUE NULLS NOT DISTINCT("household_id","graph_id","key")
);
--> statement-breakpoint
CREATE TABLE "person_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"strength" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"source_id" uuid,
	"subject_id" uuid,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"detail" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_interactions_dedupe_uq" UNIQUE("graph_id","node_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "person_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_pins_uq" UNIQUE("graph_id","user_id","node_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD COLUMN "keep_in_touch_nudges" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_roles" ADD CONSTRAINT "meta_roles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_interactions" ADD CONSTRAINT "person_interactions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_interactions" ADD CONSTRAINT "person_interactions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_interactions" ADD CONSTRAINT "person_interactions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_interactions" ADD CONSTRAINT "person_interactions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_pins" ADD CONSTRAINT "person_pins_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_pins" ADD CONSTRAINT "person_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_pins" ADD CONSTRAINT "person_pins_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_interactions_node_at_idx" ON "person_interactions" USING btree ("graph_id","node_id","at");--> statement-breakpoint
CREATE INDEX "person_interactions_source_idx" ON "person_interactions" USING btree ("source_id");