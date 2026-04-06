# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

# Build tools + libvips with full codec support (libheif + libde265 for HEIC/HEVC)
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libvips-dev \
    libheif-dev \
    libde265-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
# Rebuild Sharp from source so it links against system libvips (unlocks HEIC support)
RUN npm rebuild sharp --build-from-source

COPY . .
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner

# Runtime libs only — no build tools
RUN apt-get update && apt-get install -y \
    libvips \
    libheif1 \
    libde265-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

CMD ["npm", "start"]
