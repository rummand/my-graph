CREATE TABLE "node_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_identity_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"share_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"change_set_id" uuid,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_identities" ADD CONSTRAINT "node_identities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_identity_members" ADD CONSTRAINT "node_identity_members_identity_id_node_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."node_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_identity_members" ADD CONSTRAINT "node_identity_members_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_identity_members" ADD CONSTRAINT "node_identity_members_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "node_identity_members_node_uq" ON "node_identity_members" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_identity_members_identity_idx" ON "node_identity_members" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "node_identity_members_graph_idx" ON "node_identity_members" USING btree ("graph_id");