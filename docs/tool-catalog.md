# Tool catalog and capability switches

The runtime builds one catalog from registered host tools and tools discovered through MCP `tools/list`. Each catalog definition exposes `name`, `description` and `inputSchema`; MCP execution continues through `tools/call`.

## OpenMausBot alignment

`CatalogProfile` follows OpenMausBot's `agents-catalog-profile` idea: a bot carries a pack of independent boolean capability switches. It has no preset ID or role identity. Switches select actual tool groups in this repository; a bot can combine web and PTC, or disable shell while keeping files, regardless of its legacy role.

All eight fields are required booleans. Unknown fields, missing fields, non-booleans and old preset IDs are rejected by new configuration inputs. The host normalizes and stores the object as JSON in `bots.profile`, and returns the parsed object in bot views. The console's `POST /api/bots` accepts `profile` alongside `toolScope`. The console's `PATCH /api/bots/:id` and `BotManager.updateCatalog` change an idle bot's profile and optional scope, apply them immediately, and persist them for restart. Updates reject bots with pending/running work, and new sends are blocked during configuration. Host callers pass the same object as `configureBot.catalogProfile`; `Inbox.setBotCatalog` is the persistence boundary. A supplied profile takes precedence over legacy `tools` capabilities.

| Switch | Tool group selected |
| --- | --- |
| `core` | `current_time` and `tool_search`, including discovery of deferred tools |
| `shell` | `bash` |
| `files` | `read`, `write`, `edit` |
| `web` | CCR `web_search` and `web_fetch` |
| `ptc` | `codemode` |
| `memory` | `memory_*` and `working_*` tools |
| `reminders` | `reminder_*` tools |
| `mcp` | All tools discovered through MCP, based on host source metadata rather than their name |

Unknown host tools remain closed until assigned a group. MCP tools belong to `mcp` even when their names resemble another group. Switches select installed tools: enabling web, PTC, memory, reminders or MCP does not configure a missing deployment service. A stored enabled switch remains enabled if that service is temporarily absent. Legacy tools-only `configureBot` callers retain the configuration error when they explicitly request unavailable PTC or web extensions.

Example profile, independent of role:

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

A bot's `toolScope` is an optional exact-name `allow` list and exact-name `deny` list. Empty `allow` leaves the switch-selected defaults in effect. A non-empty `allow` intersects with those defaults; `deny` then removes names. Neither can enable a disabled group. Catalog definitions, model declarations, callable registrations, `tool_search` results for deferred MCP tools and the execution boundary for direct and nested calls use the same effective selection. A PTC script's nested calls still require each target tool's group and scope authorization.

## Legacy role and capability compatibility

The roles `assistant`, `researcher` and `programmer` remain legacy metadata. They supply defaults only when a caller omits the profile, or during one-time migration of rows without one:

| Legacy role | core | shell | files | web | ptc | memory | reminders | mcp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `assistant` | true | true | true | false | false | true | true | true |
| `researcher` | true | true | true | true | false | true | true | true |
| `programmer` | true | true | true | false | true | true | true | true |

An upgrade also converts stored old profile IDs `chief`, `research` and `programmer` to the corresponding switch packs. If an old explicit ID differs from the row's role, that explicit selection wins. The migration retains existing scopes and legacy `bots.tools` strings. Already migrated JSON profiles are never regenerated from role on restart. Invalid non-legacy profiles fail validation instead of silently selecting a preset.

`bots.tools` and the view's `tools` array remain compatibility projections: `shell` → `bash`, `files` → `files`, `ptc` → `ptc`, `web` → `web`; the last two appear only when the deployment provides them. BotManager refreshes this projection from the stored switches, without changing the switches themselves. The other groups have no representation in the legacy string.

For tools-only `configureBot` callers, `bash/files/ptc/web` independently populate the corresponding switches; `core`, `memory`, `reminders` and `mcp` stay enabled for compatibility. Both `ptc` and `web` can be selected together. There is no role-based PTC rejection and no PTC/Claude Code-specific integration in the catalog.
