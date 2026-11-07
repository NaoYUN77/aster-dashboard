# Aster dashboard: multiple bots on one machine

One app container plus one local stand-in for the shared Execution Host. The app owns the model
loop, the durable conversations and the web console; the Execution Host owns every command and file
operation. They share a Unix socket on a small volume and the workspace volume — nothing else.

```
browser ── HTTP 127.0.0.1:8787 ──> personal-agent ── unix /run/aster/rpc.sock ──> execution-host
                                    │                                              │
                                    └── personal-agent-data:/data                  └── /workspaces/<botId>
                                        (agent.sqlite, inbox.sqlite)                   (one shared volume
                                                                                         for every bot)
```

This is a **single-user MVP**. There is no per-bot container, no per-bot UID and no OS-level
isolation: all bots use the same host, the same installed software and the same workspace volume,
each with its own default working directory. The production topology is `docker-compose.rpc.yml`,
where the app on Lighthouse reaches the shared CVM Execution Host through the existing mTLS RPC
gateway. See [the shared-host runbook](../docs/runbook-shared-execution-host.md); nothing in this
overlay changes the CVM, its permissions or its firewall.

## Start

```bash
cp dashboard/.env.example dashboard/.env
# edit WEB_TOKEN, MODEL_PROVIDER, MODEL_ID and the provider key

docker compose -f docker-compose.yml -f dashboard/docker-compose.dashboard.yml \
  --env-file dashboard/.env up -d --build
```

The app image is the repository's root `Dockerfile`; the local `execution-host` service starts the
same image on `dist/src/execution/rpc-main.js` in shared-host mode as uid 1000. The overlay builds
one image, not two. The console is published only on the host's loopback address: open
`http://127.0.0.1:8787` and paste `WEB_TOKEN` when the page asks for it.

The compose overlay requires Compose with `!override` support (Docker Compose 2.24 or newer).

## Acceptance

`dashboard/acceptance/` holds the deployment acceptance kit: `run.sh` builds the overlay, checks the
loopback/token boundary, drives the console and the shared host, and verifies that a restart keeps the
bots and their history. `acceptance/README.md` maps each criterion to the evidence it prints. The
run uses its own compose project and volume names, so it never touches another deployment's data.
That kit targets the legacy explicit-profile surface and sets `ALLOW_LEGACY_CATALOG=1` itself;
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
its legacy explicit-profile checks. See [the tool catalog](../docs/tool-catalog.md) for switch
groups, scope rules and the historical database upgrade, and
[ADR-0023](../docs/adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md) for the design.

## Execution host

`/workspaces/<botId>` is both the session's default working directory and the root of its file
primitives (`read`, `write`, `edit`). The local service:

- mounts only the workspace volume, the socket volume and a private `/tmp` tmpfs;
- runs as a dedicated non-root uid (1000); `rpc-main.js` refuses to start as root in shared-host
  mode and has no root, sudo, Docker socket or control-plane credentials;
- starts no bwrap, cgroups, PTC or per-bot container;
- bounds commands at `EXECUTION_AGENT_MAX_CONCURRENT` (3) concurrent executions and clamps each
  command's output to the host's chunk/byte limits.

Phase 1 migrates Bash / Read / Write / Edit only. PTC/codemode is retired: the shared host never
advertises it (`health.check` reports `ptc: false`, `directBash: true`, `fileTools: true`,
`sharedMode: "rw"`), and the `ptc` catalog switch is a deprecated persisted key that is always
forced off. The zero-setup manifest grants `shell` when the RPC transport is configured. CC,
Herdr and the other installed CLIs are not separate Agent tools in this phase; a bot reaches them
through Bash on the shared host.

## Limitations

- By design, raw bash can traverse `/workspaces` and read another bot's directory. There is no OS
  isolation between bots; file primitives and each session's default working directory stay confined
  to `/workspaces/<botId>`, and `/data` is not mounted into the execution host. Do not treat this as
  a multi-tenant boundary.
- The concurrency bound is per RPC connection; the app holds one connection, so it is the
  deployment's global bound. A second client would get its own slots.
- Sessions are connection-scoped and not replayed: a reconnect starts new sessions. An RPC
  disconnect never re-runs a command automatically.
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
