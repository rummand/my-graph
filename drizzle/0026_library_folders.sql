CREATE TABLE "library_folder_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"graph_id" uuid,
	"name" text NOT NULL,
	"tree" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"origin" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "library_folder_templates" ADD CONSTRAINT "library_folder_templates_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folder_templates" ADD CONSTRAINT "library_folder_templates_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folder_templates" ADD CONSTRAINT "library_folder_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_parent_id_library_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."library_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_folder_templates_household_idx" ON "library_folder_templates" USING btree ("household_id","graph_id");--> statement-breakpoint
CREATE INDEX "library_folders_parent_idx" ON "library_folders" USING btree ("graph_id","parent_id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_folder_idx" ON "sources" USING btree ("graph_id","folder_id");