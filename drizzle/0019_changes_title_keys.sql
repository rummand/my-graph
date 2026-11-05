ALTER TABLE "change_sets" ADD COLUMN "title_key" text;--> statement-breakpoint
ALTER TABLE "change_sets" ADD COLUMN "title_params" jsonb;--> statement-breakpoint
-- Best effort for proposals stored before title keys: My Graph's own English titles get their key (the rest are
-- recognised when read, see src/lib/changes/titles.ts). "Resten af …" (stored in Danish) goes back to English.
UPDATE "change_sets" SET "title_key" = 'stored.titles.restOf', "title_params" = jsonb_build_object('title', (regexp_match("title", '^(?:(?:Rest of|Resten af)\s+)+(.+)$'))[1]),
  "title" = left('Rest of ' || (regexp_match("title", '^(?:(?:Rest of|Resten af)\s+)+(.+)$'))[1], 200)
  WHERE "title_key" IS NULL AND "title" ~ '^(Rest of|Resten af)\s+.+$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.fromMeeting', "title_params" = jsonb_build_object('title', (regexp_match("title", '^From the meeting “(.+)”$'))[1])
  WHERE "title_key" IS NULL AND "title" ~ '^From the meeting “.+”$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.addFromSource', "title_params" = jsonb_build_object('what', (regexp_match("title", '^Add (.+), from “(.+)”$'))[1], 'title', (regexp_match("title", '^Add (.+), from “(.+)”$'))[2])
  WHERE "title_key" IS NULL AND "title" ~ '^Add .+, from “.+”$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.fromSource', "title_params" = jsonb_build_object('title', (regexp_match("title", '^From “(.+)”$'))[1])
  WHERE "title_key" IS NULL AND "title" ~ '^From “.+”$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.fromWeb', "title_params" = jsonb_build_object('query', (regexp_match("title", '^From the web: (.+)$'))[1])
  WHERE "title_key" IS NULL AND "title" ~ '^From the web: .+$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.fromMessage', "title_params" = '{}'::jsonb WHERE "title_key" IS NULL AND "title" = 'From your message';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.aulaCalendarChanges', "title_params" = '{}'::jsonb WHERE "title_key" IS NULL AND "title" = 'Changes in the Aula calendar';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.removeDates', "title_params" = jsonb_build_object('count', ((regexp_match("title", '^Remove ([0-9]+) dates? that came from (.+)$'))[1])::int, 'label', (regexp_match("title", '^Remove ([0-9]+) dates? that came from (.+)$'))[2])
  WHERE "title_key" IS NULL AND "title" ~ '^Remove [0-9]+ dates? that came from .+$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.aulaCalendarDates', "title_params" = jsonb_build_object('count', ((regexp_match("title", '^([0-9]+) dates? from the Aula calendar$'))[1])::int)
  WHERE "title_key" IS NULL AND "title" ~ '^[0-9]+ dates? from the Aula calendar$';--> statement-breakpoint
UPDATE "change_sets" SET "title_key" = 'stored.titles.datesFrom', "title_params" = jsonb_build_object('count', ((regexp_match("title", '^([0-9]+) dates? from (.+)$'))[1])::int, 'label', (regexp_match("title", '^([0-9]+) dates? from (.+)$'))[2])
  WHERE "title_key" IS NULL AND "title" ~ '^[0-9]+ dates? from .+$';--> statement-breakpoint
UPDATE "sources" SET "meta" = "meta" || '{"titleKey": "stored.sources.aulaSensitive", "titleParams": {}}'::jsonb
  WHERE "title" = 'Sensitive, open in Aula' AND "meta"->'aula'->>'sensitive' = 'true' AND NOT ("meta" ? 'titleKey');
