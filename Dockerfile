# syntax=docker/dockerfile:1
# Production image for My Graph (Next.js standalone output).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
# Lint runs in local checks; skipping it here keeps the build inside small builders' memory.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build --no-lint

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads \
    RUN_MIGRATIONS=1 \
    MIGRATIONS_DIR=/app/drizzle

# pg_dump and psql for the nightly backups (src/lib/backup). From the PostgreSQL apt repository, so the client is at
# least as new as the database server (pg_dump refuses to dump a newer server). Without it, backups fall back to a
# table-by-table JSON dump.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV PG_DUMP_PATH=/usr/lib/postgresql/17/bin/pg_dump \
    PSQL_PATH=/usr/lib/postgresql/17/bin/psql

# Non-root user that owns the upload volume (and the backups and exports beside it).
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app \
 && mkdir -p /data/uploads /data/backups /data/exports && chown -R app:app /data

COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/drizzle ./drizzle
# The fallback text reader (tesseract.js): its WebAssembly core is loaded from disk at run time, which Next's file
# tracing doesn't see, and its English + Danish language data ship in the repo so nothing is downloaded at run time.
COPY --from=builder --chown=app:app /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core
COPY --from=builder --chown=app:app /app/assets/tesseract ./assets/tesseract
ENV TESSERACT_LANG_PATH=/app/assets/tesseract

USER app
EXPOSE 3000
# server.js reads PORT and HOSTNAME; Railway injects PORT.
CMD ["node", "server.js"]
