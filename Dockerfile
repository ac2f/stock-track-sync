# ── Derleme ────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Çalışma ────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    LOG_DIR=/app/logs \
    STATUS_PORT=3100
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Günlükler kalıcı olsun diye birime bağlanabilir; anahtar/parola yazılmaz.
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
VOLUME ["/app/logs"]
# Durum ucu yalnız konteynerin içinde (127.0.0.1) dinler.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- "http://127.0.0.1:${STATUS_PORT}/health" >/dev/null || exit 1
# SIGTERM: tur bitirilir, yazma duraklatması kaldırılır (en çok 30 sn).
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
