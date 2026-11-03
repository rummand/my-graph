CREATE TYPE "public"."graph_kind" AS ENUM('family', 'personal', 'work', 'shared', 'other');--> statement-breakpoint
CREATE TYPE "public"."graph_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "graph_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "graph_role" DEFAULT 'editor' NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "graph_role" NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"color" integer DEFAULT 210 NOT NULL,
	"kind" "graph_kind" DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "wiki_owner_slug_idx";--> statement-breakpoint
ALTER TABLE "graph_invites" ADD CONSTRAINT "graph_invites_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_invites" ADD CONSTRAINT "graph_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_members" ADD CONSTRAINT "graph_members_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_members" ADD CONSTRAINT "graph_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_invites_token_idx" ON "graph_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "graph_invites_graph_idx" ON "graph_invites" USING btree ("graph_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_members_graph_user_idx" ON "graph_members" USING btree ("graph_id","user_id");--> statement-breakpoint
CREATE INDEX "graph_members_user_idx" ON "graph_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "graphs_household_idx" ON "graphs" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "graphs_owner_idx" ON "graphs" USING btree ("owner_id");--> statement-breakpoint
-- Hand-written backfill: every existing household gets one "Family" graph that holds all of its existing content.
ALTER TABLE "chunks" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "provenance" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "graph_id" uuid;--> statement-breakpoint
-- One family graph per household, owned by the household owner (else its earliest member).
INSERT INTO "graphs" ("household_id", "owner_id", "name", "kind")
SELECT h."id",
  (SELECT u."id" FROM "users" u WHERE u."household_id" = h."id" ORDER BY (u."role" = 'owner') DESC, u."created_at" ASC LIMIT 1),
  'Family', 'family'
FROM "households" h
WHERE NOT EXISTS (SELECT 1 FROM "graphs" g WHERE g."household_id" = h."id" AND g."kind" = 'family');--> statement-breakpoint
-- Every household member joins it: owner -> owner, parent -> editor, child and guest -> viewer.
INSERT INTO "graph_members" ("graph_id", "user_id", "role")
SELECT g."id", u."id",
  (CASE u."role" WHEN 'owner' THEN 'owner' WHEN 'parent' THEN 'editor' ELSE 'viewer' END)::"graph_role"
FROM "users" u JOIN "graphs" g ON g."household_id" = u."household_id" AND g."kind" = 'family'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "nodes" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "edges" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "sources" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "chunks" t SET "graph_id" = s."graph_id" FROM "sources" s WHERE s."id" = t."source_id" AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "provenance" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "wiki_pages" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "conversations" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "reminders" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
UPDATE "observations" t SET "graph_id" = g."id" FROM "graphs" g WHERE g."household_id" = t."household_id" AND g."kind" = 'family' AND t."graph_id" IS NULL;--> statement-breakpoint
-- Rows whose household no longer exists can't be reached by anyone; they have no graph to move into.
DELETE FROM "provenance" WHERE "graph_id" IS NULL;--> statement-breakpoint
DELETE FROM "wiki_pages" WHERE "graph_id" IS NULL;--> statement-breakpoint
DELETE FROM "conversations" WHERE "graph_id" IS NULL;--> statement-breakpoint
DELETE FROM "reminders" WHERE "graph_id" IS NULL;--> statement-breakpoint
DELETE FROM "observations" WHERE "graph_id" IS NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provenance" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ALTER COLUMN "graph_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance" ADD CONSTRAINT "provenance_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_graph_idx" ON "chunks" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "conversations_graph_user_idx" ON "conversations" USING btree ("graph_id","user_id");--> statement-breakpoint
CREATE INDEX "edges_graph_idx" ON "edges" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "nodes_graph_type_idx" ON "nodes" USING btree ("graph_id","type");--> statement-breakpoint
CREATE INDEX "nodes_graph_start_idx" ON "nodes" USING btree ("graph_id","start_at");--> statement-breakpoint
CREATE INDEX "observations_graph_idx" ON "observations" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "provenance_graph_idx" ON "provenance" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "reminders_graph_due_idx" ON "reminders" USING btree ("graph_id","due_at");--> statement-breakpoint
CREATE INDEX "sources_graph_idx" ON "sources" USING btree ("graph_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_graph_slug_idx" ON "wiki_pages" USING btree ("graph_id","slug");
