ALTER TABLE "assistant_settings" ALTER COLUMN "auto_save_memories" SET DEFAULT false;
--> statement-breakpoint
UPDATE "assistant_settings" SET "auto_save_memories" = false;
