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
# Agent tools and operator commands use Bash; all mutable state belongs under /data. The
# execution broker container reuses this image and needs the OpenSSH client for its baseline
# transport; the application container keeps no SSH keys and has no route to the execution host.
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates openssh-client util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
VOLUME ["/data"]
CMD ["flock", "--no-fork", "--nonblock", "/data/app.lock", "node", "dist/src/main.js"]
