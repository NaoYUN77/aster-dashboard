# Tool catalog and capability switches

The runtime builds one catalog from registered host tools and tools discovered through MCP `tools/list`. Each catalog definition exposes `name`, `description` and `inputSchema`; MCP execution continues through `tools/call`.

> **Zero-setup is the default.** In a normal deployment the host resolves the effective
> `CatalogProfile`, `ToolScope` and exact-name denial reasons from the platform manifest, integration
> state and deployment facts; `POST /api/bots` accepts only `name`, optional `systemPrompt` and
> optional `botId`, and `PATCH /api/bots/:id` is not exposed. The explicit eight-switch profile and
> scope described below remain available only behind the host-only `ALLOW_LEGACY_CATALOG=1`
> compatibility switch (used by `dashboard/acceptance/run.sh`). See
> [ADR-0023](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md). Catalog filtering and the
> `review()` execution check are the same in both modes; a globally registered tool is never
> implicitly executable.

## OpenMausBot alignment

`CatalogProfile` follows OpenMausBot's `agents-catalog-profile` idea: a bot carries a pack of independent boolean capability switches. Switches select actual tool groups in this repository; a bot can combine web and PTC, or disable shell while keeping files.

All eight fields are required booleans. Unknown fields, missing fields, non-booleans and old preset IDs are rejected by new configuration inputs. The host normalizes and stores the object as JSON in `bots.profile`, and returns the parsed object in bot views. `POST /api/bots` requires a complete `profile` object and accepts an optional `toolScope`; it neither accepts nor returns a bot role. The console's `PATCH /api/bots/:id` and `BotManager.updateCatalog` require a complete profile to change an idle bot's capabilities and optional scope, apply them immediately, and persist them for restart. Updates reject bots with pending/running work, and new sends are blocked during configuration. Host callers must pass the same complete object as `configureBot.catalogProfile`; `Inbox.setBotCatalog` is the persistence boundary. There is no tools-only `configureBot` fallback.

| Switch | Initial value | Tool group selected |
| --- | --- | --- |
| `core` | true | `current_time` and `tool_search`, including discovery of deferred tools |
| `shell` | true | `bash` |
| `files` | true | `read`, `write`, `edit` |
| `web` | false | CCR `web_search` and `web_fetch` |
| `ptc` | false | `codemode` |
| `memory` | true | `memory_*` and `working_*` tools |
| `reminders` | true | `reminder_*` tools |
| `mcp` | true | All tools discovered through MCP, based on host source metadata rather than their name |

These are the values of `DEFAULT_CATALOG_PROFILE`, used to initialize the bootstrap bot and the console's creation form. API creation still requires the caller to submit all eight fields explicitly.

Unknown host tools remain closed until assigned a group. MCP tools belong to `mcp` even when their names resemble another group. Switches select installed tools: enabling web, PTC, memory, reminders or MCP does not configure a missing deployment service. A stored enabled switch remains enabled if that service is temporarily absent.

Example profile combining web and PTC:

```json
{
  "core": true,
  "shell": false,
  "files": true,
  "web": true,
  "ptc": true,
  "memory": false,
  "reminders": false,
  "mcp": true
}
```

The profile is the sole capability authorization input; `toolScope` can only narrow its selection. A bot's `toolScope` is an optional exact-name `allow` list and exact-name `deny` list. Empty `allow` leaves the switch-selected defaults in effect. A non-empty `allow` intersects with those defaults; `deny` then removes names. Neither can enable a disabled group. Catalog definitions, model declarations, callable registrations, `tool_search` results for deferred MCP tools and the execution boundary for direct and nested calls use the same effective selection. A PTC script's nested calls still require each target tool's group and scope authorization. Enabling `ptc` does not grant access to any other group, and PTC has no separate role-based rejection or CLI-specific integration in the catalog.

`bots.tools` and the view's `tools` array are compatibility output projections, never authorization inputs: `shell` → `bash`, `files` → `files`, `ptc` → `ptc`, `web` → `web`; the last two appear only when the deployment provides them. BotManager refreshes this projection from the stored switches, without changing the switches themselves. The other groups have no representation in the legacy string. The effective catalog and `loadedTools` also reflect deployment availability and scope; the compatibility projection cannot replace them.

## Historical database upgrade

Only the one-time database upgrade reads old roles or profile preset IDs. For a database that still has a `bots.role` column, rows without a profile are converted using the following historical mapping:

| Old role | core | shell | files | web | ptc | memory | reminders | mcp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `assistant` | true | true | true | false | false | true | true | true |
| `researcher` | true | true | true | true | false | true | true | true |
| `programmer` | true | true | true | false | true | true | true | true |

The upgrade also converts stored old profile IDs `chief`, `research` and `programmer` to the corresponding switch packs. If an old explicit ID differs from the row's role, that explicit selection wins. Existing valid JSON profiles are validated and preserved, not regenerated from old labels. Existing valid scopes are retained; an absent scope becomes empty `allow`/`deny` lists. Existing `bots.tools` strings are retained during conversion and subsequently refreshed as output projections when bots activate. Invalid profiles or scopes fail the upgrade instead of silently selecting defaults.

The profile conversion and `ALTER TABLE bots DROP COLUMN role` run in the same transaction. A failed conversion rolls back the upgrade. After a successful upgrade the column is gone; runtime configuration, views and authorization use the explicit switches and scope without reading old labels.
