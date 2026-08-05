# syntax=docker/dockerfile:1
# redSign — Next.js standalone build.
# Repo-owned Dockerfile because the deps stage needs registry auth for the
# private @redbtn scope; the platform-generated Dockerfile only copies
# package*.json. The credential is NEVER committed: it arrives as a BuildKit
# secret mount (id "npmrc"), backed by the global NPMRC redsecret that RedRun
# supplies to every git-source build, and is mounted only for the npm ci
# layer, so it never lands in an image layer or docker history.
FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
