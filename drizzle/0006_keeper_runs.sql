CREATE TABLE "keeper_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"read" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" text,
	"model" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "keeper_runs" ADD CONSTRAINT "keeper_runs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keeper_runs" ADD CONSTRAINT "keeper_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keeper_runs_graph_user_idx" ON "keeper_runs" USING btree ("graph_id","user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keeper_runs_one_running_uq" ON "keeper_runs" USING btree ("graph_id","user_id") WHERE status = 'running';