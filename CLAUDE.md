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

## Contracts

`src/lib/{auth,mux,gbrain,ingest}/index.ts` define the cross-workstream functions. Signatures are fixed; the owning
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

The **meta model** (`meta_kinds`, `meta_relations`, `meta_attributes` + `nodes.kind`) is the household's ontology:
kinds of people/places/events/topics, the relation types allowed on edges (with inverse labels), and the attributes
each kind carries (stored in `nodes.props`). Built-ins have `householdId = null`; households add their own.
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
- Checks before you finish: `npx tsc --noEmit` clean for your files; `npx next lint` no errors in your paths.
