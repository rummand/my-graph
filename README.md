# My Graph

A private family knowledge graph. GBrain stores people, places, events and facts, and every fact links back to its source. On top of it sit a library for files, photos and audio, a chat assistant, wiki pages, a timeline and family accounts. All model calls go through **mux**, the household's own model gateway. See `PROPOSAL.md` for the product and `CLAUDE.md` for how the code is organised.

Stack: Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, Postgres 16 + pgvector, Drizzle ORM.

## Local development

```bash
npm install
npm run db:up              # Postgres + pgvector in docker compose on port 5433
cp .env.example .env       # then fill in SESSION_SECRET (openssl rand -hex 32) and MUX_API_KEY
npm run db:push            # apply src/db/schema.ts
npm run db:seed            # demo household
npm run dev                # http://localhost:3000
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

When the app starts it makes sure pgvector exists and creates the GBrain search indexes and triggers (`src/instrumentation.ts`). Without mux the app still runs in a reduced mode: no extraction, keyword-only search, and the assistant says mux is unreachable.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string (needs pgvector) | `postgres://mygraph:mygraph@localhost:5433/mygraph` |
| `MUX_BASE_URL` | mux gateway base URL | `http://127.0.0.1:7070` |
| `MUX_API_KEY` | mux tenant key for "my-graph" | (empty) |
| `SESSION_SECRET` | Session cookie signing secret | (required) |
| `APP_URL` | Public URL (e.g. your Railway domain); also accepted as an allowed `Origin` for API writes (CSRF check in `src/middleware.ts`) | (optional) |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Passkey relying party: the public host name and origin | `localhost` / `http://localhost:3000` |
| `UPLOAD_DIR` | Where uploaded originals are stored. The OCR language cache goes next to it in `../tesseract-cache` | `./data/uploads` (`/data/uploads` in Docker) |
| `APP_TIME_ZONE` | Time zone for briefs and reminders | `Europe/Copenhagen` |
| `RUN_MIGRATIONS` | `1` applies the SQL migrations in `./drizzle` on startup. It is set in the Docker image. Don't use it on a database created with `db:push` | unset (`1` in Docker) |
| `PORT` | HTTP port | `3000` |

## Schema changes

Local databases use `npm run db:push`. Production applies versioned migrations, so after you change `src/db/schema.ts` run `npx drizzle-kit generate` and commit the new file in `drizzle/`.

## Deploying to Railway (EU)

The repo has a multi-stage `Dockerfile` (node:22-slim, Next standalone output, runs as a non-root user) and a `railway.json` (Dockerfile builder, health check at `/api/health`).

1. Create a Railway project and choose an **EU region** (for example `europe-west4`, Amsterdam) for both services.
2. Add **Postgres with pgvector**. Railway's plain Postgres template may not include the extension, so use a pgvector template or the `pgvector/pgvector:pg16` image. On startup the app runs `CREATE EXTENSION IF NOT EXISTS vector` and then the migrations.
3. Add the app service from this repo. Railway picks up `railway.json` and builds the Dockerfile.
4. Attach a **volume at `/data`**. Uploads go to `/data/uploads` and the OCR cache to `/data/tesseract-cache`. Railway mounts volumes as root, and the image runs as uid 1001, so also set `RAILWAY_RUN_UID=0` on the service, or the app can't write uploads.
5. Set the variables:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (the private network URL)
   - `SESSION_SECRET` (`openssl rand -hex 32`)
   - `MUX_BASE_URL`: the Railway mux gateway, for example `http://mux.railway.internal:7070` over private networking. `127.0.0.1` does not work on Railway.
   - `MUX_API_KEY`
   - `WEBAUTHN_RP_ID=<your-domain>` and `WEBAUTHN_ORIGIN=https://<your-domain>`
6. Deploy with `railway up` or by pushing to the linked branch. `GET /api/health` returns `{ ok, db, mux }`. It returns 200 when the database answers, because mux being down only reduces what the app can do.
