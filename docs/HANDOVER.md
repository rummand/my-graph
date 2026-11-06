# Handover — My Graph

State as of 6 Nov 2026. Read `CLAUDE.md` first (architecture, rules, ownership), then this file, then
`docs/proposals/operating-model.md` (where the product is heading).

## 1. Where things stand

- **main is clean and deployed.** Every change is committed and pushed; the latest Railway deploy succeeded and
  https://web-production-1858e.up.railway.app answers. Push to `main` = live on Railway (Dockerfile build, migrations
  run on start: `RUN_MIGRATIONS=1`).
- **Checks at the last integration:** `npx tsc --noEmit` clean, `npx next lint` no errors, vitest 2,205 passed
  (16 skipped), production build compiles, `npx drizzle-kit generate --name check` reports no drift.
- **Latest migration:** `drizzle/0030_you_insights.sql`.

## 2. What was built in the last two days (newest first)

| Area | Where | Notes |
| --- | --- | --- |
| Operating-model proposal (not built) | `docs/proposals/operating-model.md` | Enterprise Kernel: nine questions, relation grammar, seven laws, VSM loop, jurisdictions (twenty legal domains), packs (APQC, BIZBOK, ITIL, COBIT, SAFe …) with licence notes, SME edition, 50 sources + coverage map |
| Commitments ("Aftaler og frister") | `src/lib/commitments` (contract `types.ts`, `detect/`, `watch/`), `/commitments`, `docs/commitments.md` | Node type `commitment`; detection in every read source; clashes, contradictions, proof of done; Today line; person block |
| You ("Dig") | `src/lib/you`, `/you` | Private self-insights over years with statistical guardrails; owner-only; off for children |
| Search | `src/lib/search`, ⌘K palette, `/search` | Every section read through its own access rules |
| Token efficiency | `src/lib/assistant`, `src/lib/mux/usage.ts`, `scripts/token-report.ts`, `scripts/assistant-eval.ts` | Stable prompt prefix, `x-mux-affinity`, relevance bar, planner skipped when no service is involved |
| Live highlights | `src/lib/mentions/live`, `src/components/chat/use-live-highlights.ts` | Browser lexicon (known names in ~1 frame), per-sentence streaming model reading |
| Roles and fading | `src/lib/meta/roles.ts`, `src/lib/people/interactions` | Roles are meta-model objects (`role:<key>` edges); closeness decays per viewer |
| Rules from one link | `src/lib/corpus/crawl`, `src/lib/corpus/read`, `/rules` | Crawl + four readings; rules into the graph |
| Floating Ask window + page actions | `src/components/assistant/*`, `page-actions.ts` | Change actions always need an approval card |
| Artifacts (former wiki) | `src/lib/artifacts/kinds.ts`, `src/lib/pages` | Never show "wiki"; storage keeps old table names |
| Library versions + folders | `src/lib/ingest/revisions*.ts`, `src/lib/ingest/folders*.ts` | Renamed duplicates dropped, revisions grouped, suggested folders |
| My Graph for Mac | `mac/` (XcodeGen), `src/lib/connectors/mac`, `docs/mac-app-api.md` | Builds and tests pass; not signed/notarized |
| Connectors round 2 + Apps directory | `src/lib/connectors/**`, `src/lib/importers/**`, `connectors/mcp/directory.ts` | Danish ones in `connectors/dk` |

## 3. Gotchas (learned the hard way)

- **Restart the dev server after changing ingest, importers, jobs or the commitments watch.** The reading queue and
  schedulers load code once at start (`src/instrumentation.ts`):
  `pkill -f "next dev -p 3917"; nohup npx next dev -p 3917 > $TMPDIR/mg-dev.log 2>&1 &`
- **Only one dev server per database.** A stale dev server (an old one on :3100 was stopped on 5 Nov) shares the job
  queue and claims jobs with old code. Workers now only claim job kinds they know, but still: one server.
- **Demo login is rate-limited** (~5 logins / 15 min per IP). Reuse one session cookie in scripts.
- **Never run `next build` in the working tree while the dev server runs** — it clobbers `.next`. Build in a copy:
  `rsync` tracked files to `/tmp/mg-build`, symlink `node_modules`, `SKIP_DB_SETUP=1 npx next build --no-lint`.
- **Commit carefully when agents are mid-work:** `git mv` renames get staged and can sneak into an unrelated commit
  (this broke one deploy). Commit single files with `git commit -- <path>`, or wait until all work is in.
- **Large file streaming:** use `fileStream()` (`src/lib/storage/file-stream.ts`), never `Readable.toWeb` — it ignores
  backpressure and filled memory on Railway (the film broke at 1:20).
- **Danish copy everywhere:** every UI string in `src/lib/i18n/messages/{en,da}`; Danish quotes are „…“.
- **mux "fast" route** currently takes 3–25 s per call on the local model; it is the slowest part of live highlights.

## 4. Production configuration still missing (Railway, service `web`)

Set now: `APP_URL DATABASE_URL DOCS_UPLOAD_TOKEN MUX_API_KEY MUX_BASE_URL NODE_ENV RUN_MIGRATIONS SESSION_SECRET
UPLOAD_DIR WEBAUTHN_ORIGIN WEBAUTHN_RP_ID`.

Not set (features stay off until they are):
- `BACKUP_KEY` — nightly encrypted backups (keep a copy outside Railway).
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — payments.
- Push notification credentials (APNs) — iPhone notifications.
- `GOOGLE_CLIENT_ID/SECRET` (+ Picker API key; enable People API and Photos Picker API), `MICROSOFT_*`, `DROPBOX_*`,
  `SLACK_*`, `NOTION_*`, `GITHUB_CLIENT_ID/SECRET`, `LINEAR_*` — "Sign in with …" connectors (token-based ones work).
- `PLATFORM_ADMIN_EMAILS` defaults to the founder's address.

## 5. Not done / known issues

- **Unverified against real accounts:** Spond, Famly, MinUddannelse/Meebook, Mac helper with real Messages, live
  Google/Slack/Notion/GitHub/Linear sign-ins.
- **Mac app:** needs Developer ID signing + notarization (`mac/README.md`), an app icon (use the new mark), and a
  shortcut that doesn't clash with Finder (⌥⌘Space).
- **iPhone:** HealthKit must be enabled on the App ID before TestFlight; Health/Places/Photos untested on a device.
- **You:** re-check that the assistant avoids cause words ("is likely contributing") when citing You-insights.
- **Snoozed reminders** aren't pushed to the phone a second time.
- **Search:** add meaning matches to the ⌘K palette after the instant results; add `pg_trgm` index for big graphs.
- **Big laws:** databeskyttelsesloven-size acts take hours on the local model (budget `RULES_MODEL_BUDGET`, 220 calls).
- **Assistant:** one regression noted — "anything coming up for Noah?" attached Emma's reminders to Noah.

## 6. Queued next (agreed or proposed, waiting for a go)

1. **Operating model phase 1–2** (proposal §14): the Enterprise Kernel in the meta model (nine questions, relations,
   seven laws as rules), decision node type, SME edition (en/da), `/model`; anchoring engine. Then 2b jurisdictions
   (Denmark + EU law packs).
2. **Choose which graphs a connector feeds** (one sign-in, several target graphs, filters per graph, single-graph
   exceptions for Aula/clinical/Health).
3. **GitHub repo documents and history** (README/docs/ADRs into the library with versions; commit/PR timeline) —
   asked, not yet answered.
4. Decisions waiting on the founder: open decisions in the proposal §15; banking (Enable Banking) was left out of
   connectors round 2.

## 7. Working style (from the founder)

Many parallel agents, fast; finished work pushed to `main` (live on Railway); design quality matters (look at
screenshots); agents propose, humans decide; provenance on everything; graphs never leak; Danish + English; the work
graph for SMEs is the main product, every graph kind is a template. See the memory notes listed in `MEMORY.md`.
