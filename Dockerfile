# ─── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools needed for native modules
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript
RUN npm run build

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl tini

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Create non-root user
RUN addgroup --system --gid 1001 continuum && \
    adduser --system --uid 1001 --ingroup continuum continuum

# Copy production deps
COPY --from=deps --chown=continuum:continuum /app/node_modules ./node_modules

# Copy compiled output
COPY --from=builder --chown=continuum:continuum /app/dist ./dist

# Copy Prisma schema + generated client (needed at runtime for migrations)
COPY --from=builder --chown=continuum:continuum /app/prisma ./prisma
COPY --from=builder --chown=continuum:continuum /app/node_modules/.prisma ./node_modules/.prisma

# Copy static data files (disposable domain list, etc.)
COPY --chown=continuum:continuum data ./data

# Copy package.json for version detection
COPY --chown=continuum:continuum package.json ./

USER continuum

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1

CMD ["node", "dist/server.js"]
