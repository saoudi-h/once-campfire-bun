# Canary channel (PERF-21): A/B vs stable showed neutral throughput and
# ~10% lower RSS on this host; the canary releases day-to-day and is
# accepted as the production base. Revisit if a stable 1.4.3+ ships.
FROM oven/bun:canary
ARG REVISION=local
LABEL org.opencontainers.image.revision=$REVISION
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /rails
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun bin/build-assets.js && mkdir -p storage && chown -R bun:bun storage
ENV HTTP_PORT=80 CAMPFIRE_STORAGE_PATH=/rails/storage NODE_ENV=production
USER bun
EXPOSE 80
CMD ["bun", "src/server.ts"]