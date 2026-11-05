CREATE INDEX IF NOT EXISTS "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_source_idx" ON "observations" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provenance_source_idx" ON "provenance" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_node_idx" ON "shares" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_node_idx" ON "sources" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_revisions_page_idx" ON "wiki_revisions" USING btree ("page_id","created_at");