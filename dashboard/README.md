# Aster dashboard: multiple bots on one machine

One app container plus one sandbox container. The app owns the model loop, the durable
conversations and the web console; the sandbox owns every command and file operation. They share a
Unix socket on a small volume and the workspace volume — nothing else.

```
browser ── HTTP 127.0.0.1:8787 ──> personal-agent ── unix /run/aster/rpc.sock ──> aster-sandbox
                                    │                                              │
                                    └── personal-agent-data:/data                  └── /workspaces/<botId>
                                        (agent.sqlite, inbox.sqlite)                   (only volume the
                                                                                         sandbox sees)
```

## Start

```bash
cp dashboard/.env.example dashboard/.env
# edit WEB_TOKEN, MODEL_PROVIDER, MODEL_ID and the provider key

docker compose -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml \
  --env-file dashboard/.env up -d --build
```

The app image is the repository's root `Dockerfile`; the sandbox image is built from
`dashboard/sandbox.Dockerfile`, and the overlay builds both. The console is published only on the
host's loopback address: open `http://127.0.0.1:8787` and paste `WEB_TOKEN` when the page asks for
it.

The compose overlay requires Compose with `!override` support (Docker Compose 2.24 or newer).

## Acceptance

`dashboard/acceptance/` holds the deployment acceptance kit: `run.sh` builds the overlay, checks the
loopback/token boundary, drives the console and the sandbox, and verifies that a restart keeps the
bots and their history. `acceptance/README.md` maps each criterion to the evidence it prints. The
run uses its own compose project and volume names, so it never touches another deployment's data.
That kit targets the legacy explicit profile/PTC surface and sets `ALLOW_LEGACY_CATALOG=1` itself;
the zero-setup flow is covered by `test/zero-setup.test.ts` and `test/zero-setup-wiring.test.ts`.

## Bots

Each bot is one durable conversation in `inbox.sqlite` (`bots` table) and one worker that answers
its requests in arrival order. Zero-setup is the default: on first start the host creates and
initializes the bootstrap bot `default` (root conversation, `/workspaces` directory so an existing
single-bot installation still sees its files), and the console is immediately usable. Creating
another bot needs only a name; `POST /api/bots` accepts `name`, optional `systemPrompt` and
optional `botId`. The host derives the model, workspace, credentials, session and effective tool
catalog — the browser cannot supply a path, a credential, a tool list or a capability switch.

Capabilities come from the platform manifest, not from a user form. Unconfigured services are shown
as `unavailable` in the console's platform status panel and `GET /api/platform`; a bot missing only
optional capabilities is `degraded` (still chat-capable), while a failed workspace/session/tool
health check is `failed` and blocks chat. Initialization is idempotent, persisted in
`bot_provisioning`, re-verified on every restart and retryable via `POST /api/bots/:id/retry`.
Integration authorization requests only record `authorization_pending`; this phase does not connect
OAuth services or claim a successful connection.

The explicit eight-switch `profile` / `toolScope` surface and `PATCH /api/bots/:id` remain only
behind the host-only `ALLOW_LEGACY_CATALOG=1` switch, which `dashboard/acceptance/run.sh` sets for
its legacy explicit-profile/PTC checks. See [the tool catalog](../docs/tool-catalog.md) for switch
groups, scope rules and the historical database upgrade, and
[ADR-0023](../docs/adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md) for the design.

## Sandbox

`/workspaces/<botId>` is both the session's working directory and the root of its file primitives
(`read`, `write`, `edit`). The sandbox container:

- mounts only the workspace volume, the socket volume and a private `/tmp` tmpfs;
- runs as uid 1000 with `cap_drop: ALL`, `no-new-privileges` and `network none`;
- has a read-only root filesystem;
- bounds bash and PTC together at `ASTER_SANDBOX_CONCURRENCY` (3) concurrent executions.

The sandbox reuses the repository's RPC protocol (`src/execution/sandbox-main.ts`), so the app's
execution code, deadlines, cancellation and file primitives are the same as for a remote host. The
only difference is where isolation comes from: the container's namespaces and limits replace a
per-command `bwrap` and cgroup, and PTC reports isolation mode `container`.

PTC (code mode) is enabled in the sandbox image but is **not** granted in the default zero-setup
deployment: `computer` stays `unavailable` until the operator declares
`PLATFORM_SANDBOX_VERIFIED=1` for an acceptance-tested OS-isolated execution plane. In the legacy
`ALLOW_LEGACY_CATALOG=1` mode it is exposed when a bot's `profile.ptc` switch and scope permit it.
Each nested tool call must also pass its own capability-group and scope checks; enabling PTC grants
no additional groups and has no role-based rejection. A PTC session opens in the bot's own
directory; its runner maps that directory to the virtual `/workspace`, so a file written by the
model's bash tool is visible to a script at `/workspace/<name>`.

## Limitations

- Raw bash can still traverse `/workspaces` and read another bot's directory (`ls /workspaces`).
  File primitives and each session's working directory stay confined, and `/data` is not mounted,
  but a determined command in one bot is not fenced off from sibling directories. Per-bot mount
  namespaces inside the sandbox would need kernel features the container's `cap_drop: ALL` does
  not grant.
- The concurrency bound is per RPC connection; the app holds one connection, so it is the
  deployment's global bound. A second client would get its own three slots.
- Sandbox sessions are connection-scoped and not replayed: a reconnect starts new sessions.
- Cancelling a request stops its RPC execution. A command whose outcome is unknown is reported as
  such and never re-run automatically.

## With MITM (internal network)

Docker drops host port publishes when every network on the app is `internal: true`.
Use the extra overlay so a host-network `console-ingress` owns loopback `127.0.0.1:8787`
and forwards to the app at `10.89.143.3:8787`:

```bash
docker compose -f docker-compose.yml -f docker-compose.mitm.yml \
  -f dashboard/docker-compose.dashboard.yml -f dashboard/docker-compose.mitm.yml \
  --env-file dashboard/.env up -d --no-build
```

Set `CONSOLE_INGRESS_TARGET` only if the MITM client address is not `10.89.143.3:8787`.

