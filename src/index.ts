#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, resolveDbPath } from "./db.js";
import {
  getReport,
  getAppBreakdown,
  getGoalsProgress,
  queryEntries,
} from "./queries.js";

const PERIOD_DESCRIPTION =
  "today | yesterday | week | month | year | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD";

const server = new McpServer({
  name: "vetroscope-mcp",
  version: "0.1.0",
});

// Open DB lazily on first tool call so the server still starts cleanly when
// Vetroscope hasn't been run yet — the error then surfaces in the tool reply
// instead of crashing the stdio transport before MCP's initialize handshake.
let _db: ReturnType<typeof openDb> | null = null;
function db() {
  if (!_db) _db = openDb();
  return _db;
}

function asJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.registerTool(
  "get_report",
  {
    title: "Get time report",
    description:
      "Aggregate Vetroscope time report for a period: total active seconds, top apps, and top projects. Mirrors the desktop dashboard.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      top_apps: z.number().int().min(1).max(500).optional().describe("Max apps returned (default 50)"),
      top_projects: z.number().int().min(1).max(500).optional().describe("Max projects returned (default 50)"),
    },
  },
  async ({ period, top_apps, top_projects }) =>
    asJson(getReport(db(), period, { topApps: top_apps, topProjects: top_projects }))
);

server.registerTool(
  "get_app_breakdown",
  {
    title: "Get per-app breakdown",
    description:
      "Per-project breakdown for a single app over a period. Use this when the user asks 'what was I working on in After Effects this week?'",
    inputSchema: {
      app: z.string().describe("Exact app name as recorded by Vetroscope (e.g. 'After Effects', 'Cursor')."),
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      limit: z.number().int().min(1).max(500).optional().describe("Max projects returned (default 100)"),
    },
  },
  async ({ app, period, limit }) => asJson(getAppBreakdown(db(), app, period, limit))
);

server.registerTool(
  "get_goals_progress",
  {
    title: "Get goals progress",
    description:
      "Current progress on the user's configured Vetroscope goals (per-app and overall). Defaults to today.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
    },
  },
  async ({ period }) => asJson(getGoalsProgress(db(), period))
);

server.registerTool(
  "query_entries",
  {
    title: "Query raw entries",
    description:
      "Filtered list of raw tracking entries. Useful for digging into specific projects or finding what window titles appeared. Returns at most 5000 rows; default 200.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).optional(),
      app: z.string().optional().describe("Restrict to a single app name"),
      project: z.string().optional().describe("Restrict to a single project (exact match)"),
      search: z.string().optional().describe("Substring match against window title, project, or sub-project"),
      limit: z.number().int().min(1).max(5000).optional(),
    },
  },
  async (args) => asJson(queryEntries(db(), args))
);

async function main() {
  // Helpful diagnostic on startup — visible in client logs but doesn't pollute
  // stdio (MCP uses stdout for protocol; logs go to stderr).
  process.stderr.write(`[vetroscope-mcp] db: ${resolveDbPath()}\n`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[vetroscope-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
