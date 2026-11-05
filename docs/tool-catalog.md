# Tool catalog and bot scopes

The runtime builds one catalog from the registered host tools and tools discovered through MCP `tools/list`. Each catalog definition exposes `name`, `description` and `inputSchema`; MCP execution continues through `tools/call`.

Profiles in `src/tool-catalog.ts` select default tool groups. `assistant` maps to `chief`, `researcher` to `research`, and `programmer` to `programmer`. The existing `bots.tools` capability string remains as a compatibility projection for `configureBot` and older clients. On database upgrade, existing roles are mapped to profiles and receive an empty scope; the old capability string is retained.

A bot's `toolScope` is an optional exact-name `allow` list and exact-name `deny` list. Empty `allow` leaves the profile defaults in effect. A non-empty `allow` intersects with those defaults, and `deny` removes names after that intersection, so neither field widens the selected profile. The console's bot-create request accepts `toolScope` and returns the normalized persisted value.

The same effective catalog controls the conversation's model-visible and callable tool registrations, `tool_search` results for deferred MCP tools, and the execution boundary for direct and nested calls. `codemode` belongs only to the programmer profile and is additionally disabled when the deployment capability is off. CCR `web_search` and `web_fetch` belong to research and are available only when the deployment's web capability is enabled.
