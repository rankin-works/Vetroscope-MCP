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

Every total is split into **active** foreground time and **passive** away-listening time (e.g. background music while idle), matching the dashboard's distinction.

## Requirements

- [Vetroscope](https://rankin.works) installed and run at least once.
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

## License

MIT © Jake Rankin
