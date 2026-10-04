# Immutable production images for TakTic (OPS-004).
#
# One file, four targets:
#
#   api      compiled NestJS (`node dist/main.js`), production dependencies only
#   web      `next start` on a `next build` output, production dependencies only
#   admin    the same for the admin panel
#   migrate  the Prisma CLI and this commit's migrations, behind a wrapper that
#            runs `migrate status`, `migrate deploy` and a read-only drift
#            check — and refuses everything else (`migrate dev`, `reset`,
#            `db push`, any shadow database)
#
# Nothing is mounted from the host at runtime. The code a container runs is
# the code in its image, so pulling a commit onto the host changes nothing
# until a new image is built and a container is recreated from it — which is
# what lets the deploy script put `migrate deploy` strictly before the new
# API starts (scripts/ops/deploy-staging.sh). The development stack
# (docker-compose.yml) is untouched by this file and still bind-mounts the
# checkout with hot reload.
#
# Build it from a commit, not from a working tree:
#
#   scripts/ops/build-images.sh <sha>
#
# which pipes `git archive <sha>` in as the context, so an untracked file —
# `.env` above all — cannot reach the build. `.dockerignore` is an allowlist
# for the case where somebody runs `docker build .` anyway.
#
# web and admin bake their NEXT_PUBLIC_* values in at build time (client
# components read them, and Next inlines them), so those images are built for
# one deployment's public URLs. They are public addresses, never secrets; no
# secret is a build argument anywhere in this file.

ARG NODE_IMAGE=node:22.23.2-alpine

# ---------------------------------------------------------------------------
# Toolchain: Node + the pnpm version package.json pins.
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
# Every workspace dependency, from the lockfile and nothing else. Manifests
# first so a source-only change reuses this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=taktic-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS api-build
COPY packages/ packages/
COPY prisma/schema.prisma prisma/schema.prisma
COPY apps/api/ apps/api/
# The client is generated twice: here so `tsc` sees the models, and again
# below into the production tree the image actually ships.
RUN pnpm db:generate && \
    pnpm --filter @taktic/api build && \
    find apps/api/dist \( -name '*.map' -o -name '*.d.ts' \) -delete
# A self-contained production tree for the API: its runtime dependencies,
# @taktic/shared copied in (the API reads its JSON tables), no devDependencies.
# The Prisma client is generated into *that* tree, for this platform.
#
# `pnpm deploy` also injects the workspace root's `dependencies` (tsx, and
# esbuild through it) into every deployed tree. Nothing at runtime uses
# either, so they are removed from all three trees.
RUN --mount=type=cache,id=taktic-pnpm-store,target=/pnpm/store \
    pnpm --filter @taktic/api --prod deploy /out/api && \
    mkdir -p /out/api/prisma && cp prisma/schema.prisma /out/api/prisma/ && \
    cd /out/api && /repo/node_modules/.bin/prisma generate --schema prisma/schema.prisma && \
    rm -rf /out/api/prisma && \
    cd /out/api/node_modules && \
    rm -rf tsx .bin/tsx .pnpm/tsx@* .pnpm/esbuild@* .pnpm/@esbuild+* \
      .pnpm/node_modules/tsx .pnpm/node_modules/esbuild .pnpm/node_modules/@esbuild

# ---------------------------------------------------------------------------
FROM deps AS web-build
# Public URLs only. Required: a client bundle that falls back to
# http://localhost:3001 would ship a broken search box to every visitor.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WEB_URL=${NEXT_PUBLIC_WEB_URL}
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "NEXT_PUBLIC_API_URL build argument is required for the web image" >&2; exit 1; }
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @taktic/web build && rm -rf apps/web/.next/cache
# `next start` loads next.config.ts through TypeScript, and with no TypeScript
# installed it tries to *install* it from the registry at runtime. The runtime
# image therefore gets the same config compiled to plain ESM here — types
# stripped, nothing else changed (the headers and poweredByHeader it sets are
# what scripts/ops/smoke.sh checks on every deploy).
RUN cd apps/web && node -e "const ts=require('typescript'),fs=require('fs');fs.writeFileSync('next.config.mjs',ts.transpileModule(fs.readFileSync('next.config.ts','utf8'),{fileName:'next.config.ts',compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)"
RUN --mount=type=cache,id=taktic-pnpm-store,target=/pnpm/store \
    pnpm --filter @taktic/web --prod deploy /out/web && \
    cd /out/web/node_modules && \
    rm -rf tsx .bin/tsx .pnpm/tsx@* .pnpm/esbuild@* .pnpm/@esbuild+* \
      .pnpm/node_modules/tsx .pnpm/node_modules/esbuild .pnpm/node_modules/@esbuild

# ---------------------------------------------------------------------------
FROM deps AS admin-build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WEB_URL=${NEXT_PUBLIC_WEB_URL}
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "NEXT_PUBLIC_API_URL build argument is required for the admin image" >&2; exit 1; }
COPY packages/ packages/
COPY apps/admin/ apps/admin/
RUN pnpm --filter @taktic/admin build && rm -rf apps/admin/.next/cache
# `next start` loads next.config.ts through TypeScript, and with no TypeScript
# installed it tries to *install* it from the registry at runtime. The runtime
# image therefore gets the same config compiled to plain ESM here — types
# stripped, nothing else changed (the headers and poweredByHeader it sets are
# what scripts/ops/smoke.sh checks on every deploy).
RUN cd apps/admin && node -e "const ts=require('typescript'),fs=require('fs');fs.writeFileSync('next.config.mjs',ts.transpileModule(fs.readFileSync('next.config.ts','utf8'),{fileName:'next.config.ts',compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)"
RUN --mount=type=cache,id=taktic-pnpm-store,target=/pnpm/store \
    pnpm --filter @taktic/admin --prod deploy /out/admin && \
    cd /out/admin/node_modules && \
    rm -rf tsx .bin/tsx .pnpm/tsx@* .pnpm/esbuild@* .pnpm/@esbuild+* \
      .pnpm/node_modules/tsx .pnpm/node_modules/esbuild .pnpm/node_modules/@esbuild

# ---------------------------------------------------------------------------
# Only the root manifest's tools (prisma, @prisma/client and friends): the
# migration image needs the CLI and its engines, not the applications.
FROM base AS migrate-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=taktic-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter taktic

# ===========================================================================
# Runtime images. Code is owned by root and read-only to the process; the
# process runs as the image's unprivileged `node` user (uid 1000) and can
# write only where it has to.
# ===========================================================================

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
# The upload root is `<cwd>/uploads` (uploads.constants.ts), so the working
# directory is the same apps/api the development stack runs from, and the
# uploads volume mounts at the same /app/apps/api/uploads.
WORKDIR /app/apps/api
COPY --from=api-build /out/api/package.json ./package.json
COPY --from=api-build /out/api/node_modules ./node_modules
COPY --from=api-build /repo/apps/api/dist ./dist
# A fresh named volume is seeded from this directory, ownership included, so a
# new deployment's uploads are writable by the process from the first start.
# An existing volume keeps its own ownership; the deploy preflight checks it.
RUN mkdir -p uploads/category-images uploads/showcase-images && \
    chown -R node:node uploads
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
COPY --from=web-build /out/web/package.json ./package.json
COPY --from=web-build /out/web/node_modules ./node_modules
COPY --from=web-build /repo/apps/web/next.config.mjs ./next.config.mjs
COPY --from=web-build /repo/apps/web/public ./public
COPY --from=web-build /repo/apps/web/.next ./.next
# Next's runtime cache is the one place `next start` writes.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/robots.txt').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
# 0.0.0.0 is the container's own interface. Which host address it is
# published on is the compose file's decision (loopback only).
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS admin
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/admin
COPY --from=admin-build /out/admin/package.json ./package.json
COPY --from=admin-build /out/admin/node_modules ./node_modules
COPY --from=admin-build /repo/apps/admin/next.config.mjs ./next.config.mjs
COPY --from=admin-build /repo/apps/admin/public ./public
COPY --from=admin-build /repo/apps/admin/.next ./.next
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3002/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3002", "--hostname", "0.0.0.0"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=migrate-deps /repo/node_modules ./node_modules
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
COPY --chmod=0755 scripts/ops/prisma-migrate-guard.sh /usr/local/bin/taktic-migrate
USER node
ENTRYPOINT ["/usr/local/bin/taktic-migrate"]
CMD ["status"]
