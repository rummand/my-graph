# My Graph

A private family knowledge graph: a per-login brain (GBrain) with provenance on every fact, a chat assistant whose model
calls all go through **mux**, a library for files/photos/audio, wiki pages, a visual timeline, and family accounts.
See `PROPOSAL.md` for the product.

## Stack

- Next.js 15 App Router + React 19 + TypeScript (strict), Tailwind v4 (tokens in `src/app/globals.css`, utilities like
  `bg-surface text-muted border-line text-accent bg-accent-tint`). Shared UI in `src/components/ui` — use it.
- Postgres 16 + pgvector (docker compose, port **5433**), Drizzle ORM. Schema: `src/db/schema.ts` (the contract —
  change it only if your workstream truly needs it, additively, and say so in your report). `npm run db:push` applies it.
- No other database, queue or service. Background work = in-process async (fire-and-forget with status on the row).

## mux (model gateway) — NOT a provider SDK

mux is the household's own LLM gateway (`MUX_BASE_URL`, default `http://127.0.0.1:7070`, key `MUX_API_KEY`).
OpenAI-compatible `/v1/chat/completions`, `/v1/embeddings` (route/model `embed`, bge-m3, 1024 dims),
`/v1/audio/transcriptions` (Whisper); Anthropic-compatible `/v1/messages`. `model` is a route:
`auto | fast | agent | smart | code | multilingual | vision | embed`. Headers sent: `x-mux-agent`, `x-mux-user`,
`x-mux-trace-id`, `x-mux-tags`; `x-mux-no-fallback: 1` for sensitive data. Response headers: `x-mux-model`,
`x-mux-route`, `x-mux-request-id`. All model calls go through `src/lib/mux` — never import a provider SDK elsewhere.
The app must still work (degraded: no extraction, keyword-only search, assistant says mux is unreachable) when mux is down.
mux's own GBrain is unrelated — do not use it.

## Agents propose, humans decide

This is the rule for everything that changes the graph. Facts, people, merges, wiki edits, new kinds/relations in the
meta model, connector imports and web findings are proposals on a change set (a branch, see `src/lib/changes`) with
evidence and provenance; a person delivers (approves), edits or drops them. "Always allow" is itself a human
decision and stays revocable.

**Memory is kept by the Brain Keeper** (like mux's keeper, `/Users/rummand/_code/mux/mux/server/src/keeper.ts`): a
background agent per graph that reads what happened since its last run (chats, uploads, activity), writes down what
will matter later, updates instead of duplicating, merges and forgets what is no longer true, never rewrites what a
person wrote themselves, treats outside content as data, and journals every change with a report on the Memory page.

## GBrain (ours)

`src/lib/gbrain` is My Graph's own brain on Postgres. One brain per login (`ownerId`), with `visibility`
(`private | parents | household`) and `shares` deciding who else sees an item. Every read takes the `Viewer` and
filters; every write records a `provenance` row (source, chunk, locator, quote, activity, agent, confidence).
Facts the assistant inferred are `status: "inferred"` and never silently promoted.

**Graphs.** A person can have several graphs (Family, Personal, Work, one shared with a partner …): tables `graphs`,
`graph_members`, `graph_invites`, and a required `graph_id` on every content table. The current graph comes from the
`mg_graph` cookie (validated against membership) and is on the `Viewer` (`graphId`, `graphRole`, `graphKind` …).
Every read and write is scoped to the current graph; nothing may reference across graphs. Rules live in
`src/lib/graphs` (`scopeOf(viewer)`). A cross-graph leak is a blocker.

## Design

`DESIGN.md` is the design system (tokens, type, people colours, motion, copy). Design skills are in `.claude/skills`.

**Graphs** (`src/lib/graphs`): a person can have several separate graphs (Family, Work, one built for and shared with a
partner, …). Every content row carries `graph_id`; the viewer carries the current graph (`mg_graph` cookie, checked
against `graph_members` on every request). All reads and writes go through `scopeOf(viewer)` and pin `graph_id`;
nothing links two graphs. The family graph keeps the household rules; other graphs use member roles
(owner / editor / viewer). The shell's graph switcher (`src/components/graph-switcher.tsx`) switches, creates and shares.

## Assistant (Scout-inspired; see `docs/scout-research.md`)

- `src/lib/memory` — family rules, preferences and notes (`memories`). Scoped to the viewer's graph + visibility;
  children and guests get nothing, graph viewers read only. Memories from uploads/outside content start `pending`
  and are never used until a parent confirms. `memoryContext()` feeds chat and runs.
- `src/lib/automations` — suggestions inbox, activity log, assistant settings, automations (schedule / condition /
  heartbeat check-in) and their runs; `src/lib/recipes` — saved prompts. Approving a suggestion writes through the
  owning library as the person deciding, so access is re-checked then.
- `src/lib/assistant/run.ts` `runTask()` — headless assistant for automations, check-ins and recipes.
- **Unattended policy**: runs only read and *propose* (suggestions); they never write facts, share, change visibility
  or message anyone. "Always allow" lets a run auto-apply private reminders only, and nothing that cites a library
  document (document text is data, never instructions). In chat, a proposal resting on a document — or a memory
  whose words the user didn't say — always gets an approval card.
- **Scheduler**: started from `src/instrumentation.ts`, ticks every 60s, claims due automations with
  `FOR UPDATE SKIP LOCKED`; skips and disables automations whose owner left the graph. `DISABLE_SCHEDULER=1` turns it off.

## Versioning, web, connectors, cross-graph objects, documents

- **Changes and history** (`src/lib/changes`, `src/lib/history`; docs/versioning-plan.md). The graph works like a git
  repo. Every agent proposal is a **change set** (`proposeChanges`, ops + a receipt per op: source, quote, url,
  confidence). Only a person who may write in the graph delivers it (`deliverChangeSet`: verdicts, fingerprint check,
  one transaction, a provenance row per op marked `change:<id>`). Every gbrain and meta write lands in `graph_events`
  one field at a time (who, when, which change set). History tools: the graph at a date, compare two moments,
  who-said, checkpoints, "restore as a proposal". Pages `/changes`, `/history`. `deliverChangeSet` may only be called
  from person-triggered code (the deliver route, live-highlight Send, approving a suggestion) — a test enforces it.
- **Web research** (`src/lib/web`): `mux.search` / `mux.read` (mux's browser). Pages read become `sources` of kind
  `web` with passages and locators; facts found become a change set (origin `web`) whose quotes must appear on the page
  and contain the value. Only a minimised query leaves the graph. SSRF guard in `src/lib/web/guard.ts`.
- **Connectors** (`src/lib/connectors`): typed manifests, encrypted secrets (never returned or logged), cursors saved
  with the data, a 60s scheduler with leases, SSRF guard on every connect and redirect (development opens loopback
  only). Calendar (ICS / Aula) and IMAP; what they bring in is proposed, never written directly. Page `/connections`.
- **Cross-graph objects** (`src/lib/links`): the one allowed crossing between graphs. A node can be shared into or
  connected with another graph the person is a member of and may write in; tables `node_identities`,
  `node_identity_members`. Later changes travel only as "Update <name>" change sets in the other graph (gbrain's node
  writes call `onNodeChanged` after commit), addressed to someone in both graphs. Link events in history are shown only
  to members of every graph involved.
- **Documents and design sets** (`src/lib/artifacts`, `src/lib/design-sets`): reports, one-pagers, decks, briefs and
  profiles drafted from the current graph only (every claim cited), styled by design sets (built-in + per graph,
  versioned). A draft is private until a person publishes it; publishing pins the design set version. Page `/artifacts`.
- **Languages** (`src/lib/i18n`): English and Danish for all UI copy (`messages/<locale>/<namespace>.ts`, `getT` /
  `useT`). Text stored by the server in English is translated where it is shown, or written in the reader's language.
  Generated text (assistant, runs, check-ins, Brain Keeper) is written in the reader's language
  (`src/lib/assistant/locale.ts`, `voice.ts`) and names the graph by its kind; family wording only in family graphs.
- **Native app API** (`ios/`, see `ios/README.md`): `GET /api/auth/me` (who is signed in + current graph) and
  `GET /api/today?days=7` (the whole Today screen in one call; a failing part is null and named in `failed`).
  Documents export as PowerPoint: `GET /api/artifacts/[id]/export?format=pptx[&fonts=standard]`.
- **Unattended web**: automations, recipes and check-ins may research the web (owners/parents, `web` capability on)
  within a per-run budget (`src/lib/web/budget.ts`); what they find is a change set a person delivers.
- **Plans and admin** (`src/lib/plans`): Free / Plus / Family are public; Ultimate is hidden (never offered on any
  surface) and carries add-ons (`practice_psychology`, `practice_medical`, `insights`) that count only on the
  account's own Ultimate. Gate features on the server with `hasFeature(v, "<feature>")` (on for everyone in dev
  unless `PLANS_ENFORCE=1`; always enforced in production). Platform admins = `PLATFORM_ADMIN_EMAILS` (default the
  founder's address; those addresses are reserved, nobody can take one by changing an email). `/admin` and
  `/api/admin/**` are a 404 for everyone else; every admin action is audited (`auditAdmin`, not best-effort); reset
  links are single-use, 24 h, only the hash is stored. Admin copy is server-only (`getAdminT`), never in the client dictionary.
- **Living profiles** (`src/lib/profile`): every person/node page is a profile — sections by kind, facts as blocks
  with source chips, a TipTap notes doc with versions (`profile_docs`, `profile_doc_versions`), restore as a
  proposal, and private per-viewer insights (feature `insights`). Someone else's private node needs an edit share to
  change; clinical clients/patients only their clinician.
- **Clinical practice** (`src/lib/clinical`, `/clinical`): a `practice` graph kind (gated by the practice add-ons).
  Clients/patients are private person nodes owned by the clinician; colleagues read only via a share that a
  consent in force names (`clinicalAccess`). Every piece of work checks the written consent's purpose on the server
  (`gate`); withdrawal stops recording, hides analysis and removes shares. Drafts are proposals; signing delivers a
  change set the clinician authors. Transcription and drafting use mux with `sensitive` (no fallback). The client's
  living profile is the record's base; analysis on it (insights, assistant page context) needs consent for analysis.
- **Assistant session and panel**: one active conversation per person per graph (`assistant_sessions`,
  `GET/PUT /api/chat/active`, used by web and iOS). The Ask panel (⌘J) is on every page and sends the open page
  `{path, kind, id, title}`; the server re-reads it as the viewer in the current graph (`resolvePage`) and drops
  anything unreadable. Dictation: the browser's/iPhone's own speech recognition (da-DK / en), falling back to
  `POST /api/transcribe` (auth, 12 MB, audio types only, rate-limited, not stored, mux no-fallback).
- **iPhone**: the share extension "Send to My Graph" (files, photos, text, links → library upload or
  `/api/library/paste`), Paste in Library, dictation in Ask, and the same active session.

## Contracts

`src/lib/{auth,mux,gbrain,ingest,changes}/index.ts` define the cross-workstream functions. Signatures are fixed; the owning
workstream replaces the stub bodies (and may add helpers in its own folder). Other workstreams import only from these
index files.

## Ownership (parallel build — stay inside your paths)

| Workstream | Owns |
| --- | --- |
| auth | `src/lib/auth/**`, `src/app/login/**`, `src/app/setup/**`, `src/app/api/auth/**`, `src/app/(app)/settings/**`, `src/middleware.ts`, `scripts/seed.ts` |
| gbrain | `src/lib/gbrain/**`, `src/app/api/graph/**`, `src/app/api/nodes/**`, `src/app/(app)/graph/**`, `src/app/(app)/node/**`, `src/components/graph/**`, `src/components/provenance/**` |
| library | `src/lib/ingest/**`, `src/lib/storage/**`, `src/app/api/library/**`, `src/app/api/files/**`, `src/app/(app)/library/**`, `src/components/library/**` |
| assistant | `src/lib/mux/**`, `src/lib/assistant/**`, `src/app/api/chat/**`, `src/app/(app)/chat/**`, `src/components/chat/**` |
| wiki | `src/lib/wiki/**`, `src/app/api/wiki/**`, `src/app/(app)/wiki/**`, `src/components/wiki/**` |
| timeline | `src/lib/timeline/**`, `src/app/api/timeline/**`, `src/app/(app)/timeline/**`, `src/components/timeline/**` |
| today | `src/lib/briefs/**`, `src/app/api/reminders/**`, `src/app/(app)/page.tsx`, `src/components/today/**` |
| people & meta model | `src/lib/meta/**`, `src/lib/people/**`, `src/app/api/meta/**`, `src/app/api/people/**`, `src/app/(app)/people/**`, `src/components/people/**` |
| plans & admin | `src/lib/plans/**`, `src/app/(app)/admin/**`, `src/app/api/admin/**`, `src/components/admin/**`, `src/app/login/reset/**` |
| profile | `src/lib/profile/**`, `src/app/api/profile/**`, `src/components/profile/**` |
| clinical | `src/lib/clinical/**`, `src/app/api/clinical/**`, `src/app/(app)/clinical/**`, `src/components/clinical/**` |
| versioning | `src/lib/changes/**`, `src/lib/history/**`, `src/app/api/{changes,history,checkpoints}/**`, `src/app/(app)/{changes,history}/**`, `src/components/{changes,history}/**` |
| web | `src/lib/web/**`, `src/app/api/web/**` |
| connectors | `src/lib/connectors/**`, `src/app/api/connections/**`, `src/app/(app)/connections/**`, `src/components/connections/**` |
| cross-graph links | `src/lib/links/**`, `src/app/api/links/**`, `src/components/links/**` |
| documents | `src/lib/artifacts/**`, `src/lib/design-sets/**`, `src/app/api/{artifacts,design-sets}/**`, `src/app/(app)/artifacts/**`, `src/components/artifacts/**` |

The **meta model** (`meta_kinds`, `meta_relations`, `meta_attributes` + `nodes.kind`) is the household's ontology:
kinds of people/places/events/topics, the relation types allowed on edges (with inverse labels), and the attributes
each kind carries (stored in `nodes.props`). Built-ins have `householdId = null`; households add their own, either
household-wide (`graphId = null`) or for one graph. Keys are unique per (household, graph, …, key) — never suffix a key
to dodge another graph's element.
`src/lib/meta` is its API — read relation labels and kinds from there instead of hard-coding them.

Shared files (`src/db/**`, `src/components/ui/**`, `src/components/shell.tsx`, `src/app/layout.tsx`, `globals.css`,
`package.json`) — do not edit during the parallel build; note needed changes in your report instead.
Do not run `npm install`; every dependency is installed (check `package.json`). Need one more? Report it.

## Conventions

- Server code reads the viewer with `requireUser()`; route handlers return JSON `{ error }` with proper status codes.
- Validate input with zod at every route boundary.
- Server components by default; `"use client"` only where interaction needs it.
- Write user-facing copy in plain, specific English. Name things by what people recognize.
- Dates: store UTC, display with `date-fns` in the user's locale; Danish context (school platform Aula, CPR never stored).
- Tests: vitest, `src/**/*.test.ts`, pure logic only (no DB needed) unless a test DB is up.
- End-to-end: Playwright in `e2e/` (see `e2e/README.md`), `npm run test:e2e` against the dev server on :3917
  (`--grep-invert @slow` skips tests that wait on mux; `E2E_BASE_URL` for another server). It signs in the demo users
  and changes demo data, so don't run it while someone is recording or demoing. Output goes to `$TMPDIR/my-graph-e2e`.
- Migrations: additive, `npx drizzle-kit generate --name <area>_<what>`, applied with `npx tsx scripts/migrate.ts`;
  `npx drizzle-kit generate --name check` must report no changes afterwards.
- Checks before you finish: `npx tsc --noEmit` clean for your files; `npx next lint` no errors in your paths.
