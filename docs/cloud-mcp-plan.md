# Vetroscope Cloud MCP — Plan

> **Status:** Not started. Filed 2026-05-10 as a future project.
>
> **Why this exists:** The local stdio MCP (this repo, `vetroscope-mcp` on npm) only works in clients that spawn local processes — Claude Desktop, Claude Code, Cursor. **ChatGPT desktop, claude.ai web, and other remote-only MCP clients can't use it.** A separate cloud-hosted MCP that queries the user's cloud-synced Vetroscope data fixes that, without compromising the local-first design for power users.

## Goals

1. **One MCP surface, two delivery mechanisms.** The local stdio MCP stays the canonical fast/offline/private option. The cloud MCP serves the same tool set (or a clean subset) over HTTPS/SSE so remote-only LLM clients can consume it.
2. **Reuse the cloud-sync data.** Vetroscope already pushes entries / tags / goals / markers / settings to a cloud backend (the `synced_at_cloud` columns prove this). The cloud MCP queries that copy. No new data pipeline.
3. **Account-bound.** Each connection is scoped to one Vetroscope account via OAuth-style auth. No data leakage across users.
4. **Forward-compatible.** Future remote-only clients (e.g. claude.ai web custom connectors, ChatGPT, anything else that ships HTTPS-only MCP) work without further changes on the MCP server.

## Explicit non-goals

- **Not a replacement for the local MCP.** Local stays canonical for offline / privacy / speed.
- **Not feature-complete from day one.** Tools that depend on local-only state (e.g. `get_current_status` of the *currently running* tracker) may be omitted or behave differently.
- **Not write-capable** in v1 — same read-only posture as the local MCP. Writes are a separate later question (see "Future work").

## Architecture

```
                        ┌────────────────────────────┐
ChatGPT desktop ───┐    │                            │
claude.ai web   ───┼─►  │   Vetroscope Cloud MCP     │  ───►  Vetroscope cloud-sync DB
Other clients   ───┘    │   (HTTPS / SSE)            │        (read-only queries)
                        │                            │
                        │   - OAuth auth             │
                        │   - Per-user routing       │
                        │   - Same 18-tool surface   │
                        │     as local stdio MCP     │
                        └────────────────────────────┘
```

### Components

1. **OAuth flow** to bind a connector to a Vetroscope account. ChatGPT connector setup → "Sign in to Vetroscope" page → user authorizes → connector receives a token scoped to that user.
2. **MCP HTTPS server.** Receives MCP requests over HTTP/SSE, looks up the user from the bearer token, queries the appropriate cloud data, returns MCP responses.
3. **Query layer.** Mirrors `src/queries.ts` but against the cloud-sync backend's schema instead of local SQLite. Same tool names, same arg shapes, same response shapes — so users get identical behavior across the local and cloud MCPs (within reason; see "Compatibility caveats" below).
4. **OpenAPI / MCP discovery endpoint.** ChatGPT-style connectors fetch a manifest. Standard.

### Hosting candidates

| Option | Pros | Cons |
|--------|------|------|
| **Cloudflare Workers** | Cheap, global edge, instant cold starts | DB binding constraints depend on backend choice |
| **Fly.io** | Postgres-native, flexible | $5+/mo baseline |
| **Vercel** | Familiar, serverless | Cold starts, edge function limits |
| **Same infra as Vetroscope's existing cloud sync** | Consolidation, one auth system, shared deploy | Couples cloud MCP lifecycle to Vetroscope's backend |

Recommendation: whatever already runs Vetroscope's cloud-sync backend. Don't introduce a second piece of infra.

## Phased implementation

### Phase 0 — Decide the open questions (see below)

Don't write code until these are answered. The decisions cascade.

### Phase 1 — Read-only parity for the highest-leverage tools

Ship a Cloud MCP that supports a useful subset, not all 18 tools at once:

1. `get_report`
2. `get_app_breakdown`
3. `get_tag_breakdown`
4. `get_calendar`
5. `get_goals_progress`
6. `query_entries`
7. `list_tags`
8. `list_projects`

That's 8 tools — covers the "what did I do" / "how am I tracking goals" / "show me my projects" use cases that 80% of LLM queries hit.

### Phase 2 — Fill in the rest

Add the remaining 10 tools (`get_app_stats`, `get_sessions`, `get_calendar`, `get_device_breakdown`, `get_music_split`, `get_category_breakdown`, `get_listening_history`, `get_focus_heatmap`, `list_markers`, `get_goal_achievements`).

Defer `get_current_status` — its semantics ("what is the tracker doing *right now*") don't translate cleanly to a cloud copy with sync lag. Either omit or redefine to "what was the most recent synced entry."

### Phase 3 — Polish

- Response caching (5–30 second TTL on read-heavy tools) to keep latency low and DB load down
- Rate limiting per user
- Per-user quotas if needed (probably not)
- A `/health` endpoint
- Observability (request logs scrubbed of PII, latency histograms)

### Phase 4 (later, separate decision) — Writes

Mirrors the existing "write-capable local MCP" question. Same architectural call: writes from the Cloud MCP would have to flow back through Vetroscope's sync system to land on local devices. Out of scope for v1.

## Open decisions (must answer before Phase 1)

These are the actual blockers. Order matters because they cascade.

### 1. What does Vetroscope's cloud-sync backend look like today?

- Is it a custom server, or a managed BaaS (Supabase / Firebase / etc.)?
- What's the schema on the cloud side? Does it mirror the local SQLite schema, or is it normalized differently?
- Does the cloud have a queryable database (Postgres, MySQL, etc.) or is it currently a blob/event store?
- **If it's not yet queryable for arbitrary read patterns**, the Cloud MCP project gets bigger because the sync backend has to grow query endpoints first.

### 2. Auth model

- Does Vetroscope have user accounts in the cloud already (presumably yes, since sync is per-user)?
- Is there an existing OAuth flow we can reuse, or does it need to be built from scratch?
- Token shape: long-lived refresh token + short-lived access token, or single long-lived token?
- How are tokens revoked? (User goes to vetroscope.com → "Connected apps" → revokes ChatGPT.)

### 3. Pricing / plan model

- Is the Cloud MCP a free Vetroscope feature, gated behind a paid plan, or its own SKU?
- ChatGPT custom connectors require a Plus/Pro plan on the OpenAI side already, which sets a floor on user willingness to pay.
- Bandwidth and compute costs are tiny (text JSON, query-bound), so this is mostly a positioning decision, not an economics one.

### 4. Tool surface — strict parity vs cloud-shaped

- Should the cloud MCP expose **exactly** the same 18 tool names + arg schemas + response shapes as local? (Cleaner; users pick the MCP that fits their workflow without re-learning.)
- Or should it diverge where the cloud's data model differs (e.g. omit `is_passive` if cloud doesn't track that, or expose new tools that only make sense in cloud)?
- **Recommendation:** strict parity. The current local schema is rich; if the cloud has less detail, fields can be null. Keep tool surface identical.

### 5. Sync lag tolerance

- Vetroscope's local→cloud sync has some delay (push interval, batching). What's the typical lag — seconds, minutes?
- The Cloud MCP's "today" report will be missing the most recent local activity until sync catches up.
- Document this clearly in tool descriptions; LLMs and users can compensate.

### 6. Coexistence semantics

- Local MCP and Cloud MCP can both be installed simultaneously. What happens?
- Each shows up as a separate connector with potentially different totals (local sees fresh data; cloud sees synced data).
- **Recommendation:** name them differently in `serverInfo` (`vetroscope-mcp` local vs `vetroscope-cloud` remote) so users can tell which is which. Document the trade-off in both READMEs.

## Compatibility caveats

Tools that don't translate 1:1 between local and cloud:

| Tool | Caveat |
|------|--------|
| `get_current_status` | Local: real-time tracker state. Cloud: most recent synced entry, lagging by sync interval. Either omit or redefine. |
| `get_calendar` for "today" | Same lag issue — last hour of activity may be missing. |
| `query_entries` recent rows | Same — missing the unsync'd tail. |
| `get_goals_progress` for "today" | Same lag, but goal totals will catch up as soon as sync runs. |
| Settings-driven filters (`ignored_apps`, `ignored_breakdown_patterns`, `days_filter`) | These need to be accessible from the cloud DB. If sync includes settings (already does — `synced_at_cloud` is on `settings` rows), this works. If not, add settings sync first. |

## Risks

1. **Cloud sync backend isn't query-shaped today.** Most likely risk. If the cloud is currently an append-only event log or a blob store, building a queryable view is the bulk of the work, and the MCP server is the easy part.
2. **OAuth complexity creep.** If Vetroscope's existing auth is session-cookie-based for the desktop app, building a proper OAuth provider for third-party connector consent is real work. Tempting shortcut: let users paste a long-lived API token. Less polished UX but ships faster for v1.
3. **Schema drift.** As Vetroscope evolves, both the local SQLite schema and the cloud schema can drift. Keeping query results consistent across local stdio and cloud MCP requires discipline. A shared "query semantics" doc that both implementations honor would help.
4. **Privacy posture shift.** Local MCP has been marketed as "no cloud round-trip, works offline." The Cloud MCP necessarily routes data through Vetroscope-controlled infra — this is a separate privacy story (still better than Google Calendar / Slack-style integrations, since you control the cloud). The README needs to be clear which is which.
5. **Cost of supporting two implementations.** Bug fixes have to land in both. Tool description changes too. Consider extracting a shared "query semantics" package or at least a shared test suite that exercises identical inputs against both backends.

## Future work (post-v1)

- **Writes:** create markers, create tags, manage ignore lists, auto-tag suggestions. Same architectural flow as the local-MCP write proposal — must round-trip through Vetroscope's existing IPC handlers, in this case via the cloud sync's write API.
- **Webhooks / real-time:** SSE push when new entries sync, so the LLM's context can stay live during long sessions. Probably overkill until proven needed.
- **Public read-only sharing tokens:** ability to generate a scoped, time-limited token that exposes a read-only subset (e.g. "share my week's coding hours with my coach"). Cute idea, low priority.

## Questions to decide before we touch this again

1. What's the cloud sync backend? (Determines 60% of the project size.)
2. Does it support arbitrary queries today, or only sync push/pull?
3. Is there an existing OAuth flow to reuse?
4. Free / paid / bundled?
5. Is "same 18-tool surface, parity" the design target, or is divergence okay?

Answering these turns this from a vague plan into a real engineering ticket.
