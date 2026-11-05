CREATE TABLE "you_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"feedback" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "you_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mood" boolean DEFAULT false NOT NULL,
	"combine" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb,
	"mood_cache" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "you_insights" ADD CONSTRAINT "you_insights_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "you_insights" ADD CONSTRAINT "you_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "you_settings" ADD CONSTRAINT "you_settings_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "you_settings" ADD CONSTRAINT "you_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "you_insights_key_uq" ON "you_insights" USING btree ("graph_id","user_id","key");--> statement-breakpoint
CREATE INDEX "you_insights_owner_idx" ON "you_insights" USING btree ("graph_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "you_settings_graph_user_uq" ON "you_settings" USING btree ("graph_id","user_id");--> statement-breakpoint
CREATE INDEX "you_settings_due_idx" ON "you_settings" USING btree ("enabled","computed_at");