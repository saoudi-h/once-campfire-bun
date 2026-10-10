# Bun 1.4.3 stable (was canary since PERF-21: canary carried the
# Bun.spawn stdout fix that 1.4.2 stable lacked; 1.4.3 ships it,
# and the canary's ~10% RSS edge is under re-measurement).
FROM oven/bun:1.4.3
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