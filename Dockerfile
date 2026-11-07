# ---- 1. Build the web app (app.<domain>) ----
FROM node:26-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Runtime: API + Baileys + built SPA ----
FROM node:26-slim
ENV NODE_ENV=production \
    PORT=4100 \
    DATA_DIR=/app/server/data \
    WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY --from=web /web/dist /app/web/dist
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node
EXPOSE 4100
VOLUME ["/app/server/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node >= 24 runs TypeScript directly (type stripping) — no build step.
CMD ["node", "src/index.ts"]
