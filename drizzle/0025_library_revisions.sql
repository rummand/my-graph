ALTER TABLE "sources" ADD COLUMN "lineage_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "doc_key" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "name_key" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "content_key" text;--> statement-breakpoint
CREATE INDEX "sources_lineage_idx" ON "sources" USING btree ("graph_id","lineage_id");--> statement-breakpoint
CREATE INDEX "sources_dockey_idx" ON "sources" USING btree ("graph_id","doc_key");--> statement-breakpoint
CREATE INDEX "sources_namekey_idx" ON "sources" USING btree ("graph_id","name_key");--> statement-breakpoint
CREATE INDEX "sources_contentkey_idx" ON "sources" USING btree ("graph_id","content_key");