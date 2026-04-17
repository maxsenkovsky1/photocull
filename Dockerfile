# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Dummy DATABASE_URL so next build can collect page data without a real DB.
# The real value is injected at runtime by Railway.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV DATABASE_URL=$DATABASE_URL
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

CMD ["npm", "start"]
