FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9 --activate

FROM base AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ cmake \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/backend/scripts ./packages/backend/scripts/
COPY packages/web/package.json ./packages/web/

RUN pnpm install --frozen-lockfile --node-linker=hoisted

COPY . .

RUN pnpm build:backend
RUN pnpm build:web

RUN pnpm prune --prod --no-optional

FROM node:22-slim AS runtime
WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/scripts ./packages/backend/scripts
COPY --from=builder /app/packages/web/dist ./packages/web/dist

RUN mkdir -p /app/data

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
CMD ["node", "packages/backend/dist/index.js"]
