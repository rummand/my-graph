ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'recording';--> statement-breakpoint
CREATE TABLE "recording_timelines" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"graph_id" uuid NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"peaks" jsonb,
	"timing" text DEFAULT 'exact' NOT NULL,
	"has_audio" boolean,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_timelines" ADD CONSTRAINT "recording_timelines_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_timelines" ADD CONSTRAINT "recording_timelines_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_timelines_graph_idx" ON "recording_timelines" USING btree ("graph_id");