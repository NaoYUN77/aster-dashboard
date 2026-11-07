FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim
LABEL org.opencontainers.image.title="Aster"
WORKDIR /app
ENV NODE_ENV=production \
    NODE_USE_ENV_PROXY=1 \
    DATA_DIR=/data \
    HOME=/data \
    NPM_CONFIG_CACHE=/data/.npm
# Agent tools and operator commands use Bash; all mutable state belongs under /data. The legacy SSH
# broker reuses this image and needs the OpenSSH client; the dashboard overlay's local Execution
# Host stand-in also reuses it, so /workspaces and /run/aster must exist and be owned by uid 1000
# (Docker copies that ownership into the named volumes). Production runs rpc-main.js on the CVM.
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates openssh-client util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /workspaces /run/aster && chown node:node /data /workspaces /run/aster
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The local console page is served from the image; it is static and needs no build step.
COPY --chown=node:node dashboard/web ./dashboard/web
# Loopback ingress used when the app has no publishable network (dashboard/docker-compose.mitm.yml).
COPY --chown=node:node dashboard/console-ingress.mjs ./dashboard/console-ingress.mjs
USER node
VOLUME ["/data"]
CMD ["flock", "--no-fork", "--nonblock", "/data/app.lock", "node", "dist/src/main.js"]
