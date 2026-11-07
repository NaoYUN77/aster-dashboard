# Tool catalog and capability switches

The runtime builds one catalog from registered host tools and tools discovered through MCP `tools/list`. Each catalog definition exposes `name`, `description` and `inputSchema`; MCP execution continues through `tools/call`.

> **Zero-setup is the default.** In a normal deployment the host resolves the effective
> `CatalogProfile`, `ToolScope` and exact-name denial reasons from the platform manifest, integration
> state and deployment facts; `POST /api/bots` accepts only `name`, optional `systemPrompt` and
> optional `botId`, and `PATCH /api/bots/:id` is not exposed. The explicit eight-key profile and
> scope described below remain available only behind the host-only `ALLOW_LEGACY_CATALOG=1`
> compatibility switch (used by `dashboard/acceptance/run.sh`). See
> [ADR-0023](adr/zero-setup-bot-runtime/0023-zero-setup-bot-runtime.md). Catalog filtering and the
> `review()` execution check are the same in both modes; a globally registered tool is never
> implicitly executable.

## OpenMausBot alignment

`CatalogProfile` follows OpenMausBot's `agents-catalog-profile` idea: a bot carries a pack of independent boolean capability switches. Switches select actual tool groups in this repository; a bot can enable web, or disable shell while keeping files. The persisted `ptc` and `reminders` keys remain for profile compatibility only, are forced off, and select no tools.

All eight fields are required booleans. Unknown fields, missing fields, non-booleans and old preset IDs are rejected by new configuration inputs. The host normalizes and stores the object as JSON in `bots.profile`, and returns the parsed object in bot views. In legacy compatibility mode, `POST /api/bots` requires a complete `profile` object and accepts an optional `toolScope`; it neither accepts nor returns a bot role. The console's `PATCH /api/bots/:id` and `BotManager.updateCatalog` require a complete profile to change an idle bot's capabilities and optional scope, apply them immediately, and persist them for restart. Updates reject bots with pending/running work, and new sends are blocked during configuration. Host callers must pass the same complete object as `configureBot.catalogProfile`; `Inbox.setBotCatalog` is the persistence boundary. There is no tools-only `configureBot` fallback.

| Switch | Initial value | Tool group selected |
| --- | --- | --- |
| `core` | true | `current_time` and `tool_search`, including discovery of deferred tools |
| `shell` | true | `bash` |
| `files` | true | `read`, `write`, `edit` |
| `web` | false | CCR `web_search` and `web_fetch` |
| `ptc` | false | Deprecated compatibility key; forced off, no tools |
| `memory` | true | `memory_*` and `working_*` tools |
| `reminders` | false | Deprecated compatibility key; forced off, no tools |
| `mcp` | true | All tools discovered through MCP, based on host source metadata rather than their name |

These are the values of `DEFAULT_CATALOG_PROFILE`, used to initialize the bootstrap bot and the console's creation form. Legacy API creation still requires the caller to submit all eight fields explicitly. The platform's `task` capability ID is also retained for compatibility but forced off; there is no reminder delivery path.

Unknown host tools remain closed until assigned a group. MCP tools belong to `mcp` even when their names resemble another group. Switches select installed tools: enabling web, memory or MCP does not configure a missing deployment service. A stored enabled switch remains enabled if that service is temporarily absent. Deprecated keys cannot enable retired tools; PTC/code mode history is retained in the [archive](../archive/ptc-codemode/README.md).

Example profile enabling web while keeping shell disabled:

```json
{
  "core": true,
  "shell": false,
  "files": true,
  "web": true,
  "ptc": false,
  "memory": false,
  "reminders": false,
  "mcp": true
}
```

The profile is the sole capability authorization input; `toolScope` can only narrow its selection. A bot's `toolScope` is an optional exact-name `allow` list and exact-name `deny` list. Empty `allow` leaves the switch-selected defaults in effect. A non-empty `allow` intersects with those defaults; `deny` then removes names. Neither can enable a disabled group. Catalog definitions, model declarations, callable registrations, `tool_search` results for deferred MCP tools and the execution boundary use the same effective selection.

`bots.tools` and the view's `tools` array are compatibility output projections, never authorization inputs: `shell` → `bash`, `files` → `files`, `web` → `web`; web appears only when the deployment provides it. BotManager refreshes this projection from the stored switches, without changing the active switches themselves. The other groups have no representation in the legacy string. The effective catalog and `loadedTools` also reflect deployment availability and scope; the compatibility projection cannot replace them.

## Historical database upgrade

Only the one-time database upgrade reads old roles or profile preset IDs. For a database that still has a `bots.role` column, rows without a profile are converted using the following historical mapping. The retired `ptc` and `reminders` values shown here describe the old mapping only; current profiles force both off.

| Old role | core | shell | files | web | ptc | memory | reminders | mcp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `assistant` | true | true | true | false | false | true | true | true |
| `researcher` | true | true | true | true | false | true | true | true |
| `programmer` | true | true | true | false | true | true | true | true |

The upgrade also converts stored old profile IDs `chief`, `research` and `programmer` to the corresponding switch packs. If an old explicit ID differs from the row's role, that explicit selection wins. Existing JSON profiles are validated with the deprecated keys normalized off; active switches are not regenerated from old labels. Existing valid scopes are retained; an absent scope becomes empty `allow`/`deny` lists. Existing `bots.tools` strings are retained during conversion and subsequently refreshed as output projections when bots activate. Invalid profiles or scopes fail the upgrade instead of silently selecting defaults.

The profile conversion and `ALTER TABLE bots DROP COLUMN role` run in the same transaction. A failed conversion rolls back the upgrade. After a successful upgrade the column is gone; runtime configuration, views and authorization use the explicit switches and scope without reading old labels. Retiring PTC, Telegram and reminders does not delete existing SQLite tables or data.
