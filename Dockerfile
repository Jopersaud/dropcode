# syntax=docker/dockerfile:1
# dropcode signaling server + static web client.
# Base images are pinned by tag and digest; bump both together.

FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384 AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY shared ./shared
COPY server/src ./server/src
COPY web ./web
RUN node scripts/build-web.mjs --minify && npm run build:server

FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
# The server bundle includes its only runtime dependency (ws): no node_modules.
COPY --from=build /app/server/dist/index.js ./server/dist/index.js
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/dist/index.js"]
