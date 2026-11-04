DROP INDEX IF EXISTS "meta_attributes_key_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "meta_kinds_key_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "meta_relations_key_idx";--> statement-breakpoint
ALTER TABLE "meta_attributes" ADD CONSTRAINT "meta_attributes_graph_key_uq" UNIQUE NULLS NOT DISTINCT("household_id","graph_id","node_type","kind_key","key");--> statement-breakpoint
ALTER TABLE "meta_kinds" ADD CONSTRAINT "meta_kinds_graph_key_uq" UNIQUE NULLS NOT DISTINCT("household_id","graph_id","node_type","key");--> statement-breakpoint
ALTER TABLE "meta_relations" ADD CONSTRAINT "meta_relations_graph_key_uq" UNIQUE NULLS NOT DISTINCT("household_id","graph_id","key");