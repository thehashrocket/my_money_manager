# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
RUN corepack enable

# --- deps: install with the native toolchain better-sqlite3 needs to build --
FROM base AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- builder: compile the app + the two container-only scripts -----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# esbuild-bundles docker/entrypoint.src.mjs -> docker/entrypoint.mjs and
# scripts/snapshot-cli.src.mjs -> scripts/snapshot-cli.mjs. Both need to be
# self-contained: the runner stage below has no src/ tree and no
# devDependencies. See docker/entrypoint.src.mjs's file comment.
RUN pnpm build:docker-artifacts

# --- runner: no build toolchain, no devDependencies -----------------------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/docker ./docker
COPY --from=builder /app/scripts ./scripts

# No explicit `better-sqlite3` copy: it's in Next's serverExternalPackages
# list, so `.next/standalone` already has the resolved package tree
# (native binary included) from the COPY above. Copying it again from
# `deps` here would overwrite that correctly-traced copy with a broken one
# under pnpm's symlink layout — see docs/plans/dockerize-postgres.md.

# The named volume / bind mount below are created root-owned by default; the
# app runs as the unprivileged `node` user, so it needs write access set up
# while we're still root.
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups

USER node
EXPOSE 3000
CMD ["node", "/app/docker/entrypoint.mjs"]
