# The sandbox container: same RPC protocol as the remote execution agent, but the container itself
# is the isolation boundary. It mounts the workspace volume and the socket volume, nothing else.
#
# Build from the repository root (the compose overlay does this):
#   docker build -f dashboard/sandbox.Dockerfile -t aster-sandbox:local .

FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim
LABEL org.opencontainers.image.title="Aster sandbox"
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/aster
# Bash is what the tools expect; the rest of the image stays minimal. The directories that are
# mounted from volumes are created here so a fresh named volume inherits the sandbox user's
# ownership instead of root's.
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspaces /home/aster/run /tmp/aster-sessions \
    && chown -R node:node /workspaces /home/aster /tmp/aster-sessions
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Same uid/gid as the app image's `node` user: the socket is 0600 and both sides must reach it.
USER node
VOLUME ["/workspaces", "/home/aster/run"]
CMD ["node", "dist/src/execution/sandbox-main.js"]
