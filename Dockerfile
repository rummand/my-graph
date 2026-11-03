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
    NODE_OPTIONS=--max-old-space-size=1024
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

# Non-root user that owns the upload volume.
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app \
 && mkdir -p /data/uploads /data/tesseract-cache && chown -R app:app /data

COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/drizzle ./drizzle

USER app
EXPOSE 3000
# server.js reads PORT and HOSTNAME; Railway injects PORT.
CMD ["node", "server.js"]
