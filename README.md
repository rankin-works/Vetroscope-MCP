# Vetroscope MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for [Vetroscope](https://rankin.works) — gives LLMs (Claude Desktop, Claude Code, ChatGPT, Cursor, …) context on how you've been spending your time, what projects you've been in, and how you're tracking against your goals.

Reads your local Vetroscope SQLite directly, **read-only**. No cloud round-trip, no auth, works offline.

## Tools

| Tool | What it does |
|------|--------------|
| `get_report` | Aggregate report for a period — total active seconds, top apps, top projects. Mirrors the desktop dashboard. |
| `get_app_breakdown` | Per-project breakdown for a single app over a period. |
| `get_goals_progress` | Current progress on your configured goals. |
| `query_entries` | Filtered list of raw tracking entries (app, project, search, period). |

All `period` arguments accept: `today`, `yesterday`, `week`, `month`, `year`, `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`.

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
