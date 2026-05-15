# Vetroscope MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for [Vetroscope](https://vetroscope.com) — gives LLMs (Claude Desktop, Claude Code, ChatGPT, Cursor, …) context on how you've been spending your time, what projects you've been in, and how you're tracking against your goals.

Reads your local Vetroscope SQLite directly, **read-only**. No cloud round-trip, no auth, works offline.

## Tools

**Reports & breakdowns**

| Tool | What it does |
|------|--------------|
| `get_report` | Aggregate report for a period — total active seconds, top apps, top projects with sub-projects nested (YouTube videos, SoundCloud songs, Netflix episodes). |
| `get_app_breakdown` | Per-project breakdown for a single app over a period, with sub-projects. |
| `get_app_stats` | Deep stats for one app: lifetime totals, days active, daily series, hour-of-day distribution, weekday distribution. |
| `get_tag_breakdown` | Time-spent report for a single tag — top apps, top projects, daily series, active/passive split. |
| `get_calendar` | Dense per-day series (heatmap data) for any period — defaults to a full year. |
| `get_device_breakdown` | Per-device totals when you run Vetroscope across multiple machines. |
| `get_music_split` | Music-vs-work analysis: work-with-music / music-only / heads-down-work / other, plus per-source (Spotify, SoundCloud, …) overlap totals. Classifier is overridable per call. |
| `get_category_breakdown` | Time rolled up into broad categories: editor, browser, adobe, communication, gaming, productivity, creative, etc. Mirrors Vetroscope's internal app grouping. |
| `get_listening_history` | Top tracks and top artists across native music apps and browser music sites, plus per-day listening minutes. Artists parsed from the "Artist — Title" sub_project convention. |
| `get_media_links` | Canonical deep-links Vetroscope captured for media you actually played — Spotify `spotify:track:…` URIs and YouTube `youtube.com/watch?v=…` URLs — joined with the matching time data. Requires Vetroscope ≥ 0.2.30 with `capture_media_links` enabled. |
| `get_focus_heatmap` | 7×24 grid of active foreground seconds — when do you usually do specific kinds of work. Optional app / project / tag filter to narrow to a single activity. |

**Reference / lookup**

| Tool | What it does |
|------|--------------|
| `list_tags` | All your tags with id, name, color, sticky flag. |
| `list_projects` | Every (app, project) pair ever tracked with all-time totals + first/last seen + optional substring search. |
| `list_markers` | Your timeline markers (timestamp, label, color, icon, optional region end). |

**Activity / status**

| Tool | What it does |
|------|--------------|
| `get_sessions` | Continuous activity blocks (start/end/duration) — the natural grain for "what did I work on this morning". |
| `get_current_status` | Most recent entry — what app/project right now, how recently, tracking vs idle. |
| `query_entries` | Filtered list of raw 30s entries (app / project / tag / search / period / mode). |

**Goals**

| Tool | What it does |
|------|--------------|
| `get_goals_progress` | Current progress on configured app / overall / tag goals. |
| `get_goal_achievements` | Historical record of which goals you hit on which days — drives streak questions. |

All time-aware tools accept these shared filters:

| Argument | Purpose |
|----------|---------|
| `period` | `today` · `yesterday` · `week` · `month` · `year` · single date `YYYY-MM-DD` · inclusive range `YYYY-MM-DD..YYYY-MM-DD` |
| `hour_start` / `hour_end` | Inclusive / exclusive hour-of-day filter in local time (e.g. `9` and `17` = working hours) |
| `weekdays` | Array of weekday integers (0=Sun, 1=Mon, …, 6=Sat). Pass `[1,2,3,4,5]` for weekdays only. |
| `device` | `current` (the local machine), a device UUID from `get_device_breakdown`, or a platform name (`darwin`, `win32`, `browser-extension`). Omit for all devices. |

Every total is split into **active** foreground time and **passive** away-listening time (e.g. background music while idle), matching the dashboard's distinction.

## Requirements

- [Vetroscope](https://vetroscope.com) installed and run at least once.
- Node.js 18+.

## Install

```bash
npx vetroscope-mcp
```

That's it — no global install needed. The first run will fetch the package from npm.

## Configure your client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "vetroscope": {
      "command": "npx",
      "args": ["-y", "vetroscope-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add vetroscope -- npx -y vetroscope-mcp
```

### ChatGPT (Developer Mode)

In the **Connectors** section, add a new MCP server with command `npx` and args `-y vetroscope-mcp`.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vetroscope": {
      "command": "npx",
      "args": ["-y", "vetroscope-mcp"]
    }
  }
}
```

## How it finds your database

Vetroscope stores its SQLite at:

- macOS: `~/Library/Application Support/Vetroscope/`
- Windows: `%APPDATA%\Vetroscope\`
- Linux: `~/.config/Vetroscope/`

If you're signed into a Vetroscope account, the active DB is `vetroscope-<userId>.db` (recorded in `auth-state.json`). Otherwise it's the anonymous `vetroscope.db`.

You can override either piece with environment variables:

| Env var | Purpose |
|---------|---------|
| `VETROSCOPE_DIR` | Override the app-data directory |
| `VETROSCOPE_DB_PATH` | Point at an explicit `.db` file |

## Example prompts

- *"How much time did I spend in After Effects this week?"*
- *"What did I work on yesterday?"*
- *"Am I on track to hit my coding goal today?"*
- *"What were the top three projects I touched this month?"*
- *"Show me every session that touched the 'Vetroscope' project this week."*
- *"How much time did I spend on the Vetroscope Dev tag this month?"*
- *"When during the day do I usually use Cursor?"*
- *"How many hours of focused work did I do during weekday working hours (9–5) last week?"*
- *"Which YouTube videos did I watch yesterday and how long?"*
- *"What am I doing right now?"*
- *"Show me my longest focused work sessions today."*
- *"How many days in a row have I hit my coding goal?"*
- *"What was happening during my 'Eye appointment' marker on Wednesday?"*
- *"Have I ever worked on a project called 'Atlas'?"*
- *"What was my busiest day this year?"*
- *"How much of my coding time was on my Mac vs Windows this month?"*
- *"How much of my work this week had music playing?"*
- *"How long did I spend just listening to music with nothing else open today?"*
- *"How much creative work vs coding did I do this month?"*
- *"Who were my top five artists this week?"*
- *"When during the week do I usually code in Cursor?"*

## Local development

```bash
git clone https://github.com/rankin-works/Vetroscope-MCP.git
cd Vetroscope-MCP
npm install
npm run build
node dist/index.js   # starts a stdio MCP server (mainly useful via a client)
```

Type-check only:

```bash
npm run typecheck
```

## How it works

The server is a thin query adapter over the same SQLite database that Vetroscope writes. It mirrors the bucket-distinct duration math used in `electron/database.ts` so totals match the desktop dashboard exactly.

Because it reads the schema directly, a Vetroscope schema migration could break the MCP. The set of tools is intentionally narrow — purpose-built rather than a generic SQL surface — so changes localize to `src/queries.ts`.

## Stability guarantees

Starting with **1.0.0**, vetroscope-mcp follows [Semantic Versioning](https://semver.org). The public API surface — tool names, parameter names, parameter semantics, and response field names — is stable and changes follow these rules:

| Change | SemVer bump |
|--------|-------------|
| Adding a new tool | minor (1.x.0) |
| Adding a new optional argument to an existing tool | minor |
| Adding a new field to an existing response | minor |
| Renaming a tool, argument, or response field | **major** (2.0.0) |
| Changing a parameter's accepted values or default | **major** |
| Changing the meaning of an existing field (e.g. seconds → minutes) | **major** |
| Removing a tool, argument, or response field | **major** |
| Tightening validation in a way that breaks previously valid input | **major** |

Bug fixes and internal refactors that don't change the API surface are patch bumps (1.0.x).

Things explicitly **not** under the SemVer contract:

- Internal helpers and types not exported from the npm package
- The set of canonical app names in `src/categories.ts` (the `categorizeApp` function may classify the same app differently between minor versions as Vetroscope adds apps)
- The exact wording of tool descriptions
- Error message text

If you build something on top of vetroscope-mcp and want to lock to a major version, pin to `^1.0.0` in your dependency.

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## License

MIT © Jacob Rankin
