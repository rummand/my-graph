CREATE TABLE "account_addons" (
	"user_id" uuid NOT NULL,
	"addon" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_addons_user_id_addon_pk" PRIMARY KEY("user_id","addon")
);
--> statement-breakpoint
CREATE TABLE "account_controls" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"lock_reason" text,
	"temp_password_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_plans" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"plan_key" text NOT NULL,
	"feature" text NOT NULL,
	CONSTRAINT "plan_features_plan_key_feature_pk" PRIMARY KEY("plan_key","feature")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"description" text,
	"stripe_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_addons" ADD CONSTRAINT "account_addons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_controls" ADD CONSTRAINT "account_controls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_plans" ADD CONSTRAINT "account_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_plans" ADD CONSTRAINT "account_plans_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_key_plans_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plans"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_idx" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "plans" ("key", "name", "public", "sort", "description") VALUES
	('free', 'Free', true, 10, 'One household graph, the library and the assistant.'),
	('plus', 'Plus', true, 20, 'More graphs, Documents and web reading.'),
	('family', 'Family', true, 30, 'Everything in Plus, for the whole household, with shared graphs and corpora.'),
	('ultimate', 'Ultimate', false, 100, 'Everything, plus the add-ons granted to this account.')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "plan_features" ("plan_key", "feature") VALUES
	('free', 'assistant'), ('free', 'library'),
	('plus', 'assistant'), ('plus', 'library'), ('plus', 'multiple_graphs'), ('plus', 'documents'), ('plus', 'web_reading'),
	('family', 'assistant'), ('family', 'library'), ('family', 'multiple_graphs'), ('family', 'documents'), ('family', 'web_reading'),
	('family', 'family_members'), ('family', 'shared_graphs'), ('family', 'corpora'),
	('ultimate', 'assistant'), ('ultimate', 'library'), ('ultimate', 'multiple_graphs'), ('ultimate', 'documents'), ('ultimate', 'web_reading'),
	('ultimate', 'family_members'), ('ultimate', 'shared_graphs'), ('ultimate', 'corpora'), ('ultimate', 'priority_support')
ON CONFLICT DO NOTHING;
