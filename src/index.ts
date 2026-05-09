#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Bundle the Vetroscope app icon as data URIs in serverInfo.icons so MCP
 * clients (Claude Desktop, Cursor, etc.) can show the logo next to the
 * connector. Embedded rather than URL-referenced so the MCP stays fully
 * offline — no network fetch on init.
 */
function loadIcon(filename: string, sizes: string[]): {
  src: string;
  mimeType: "image/png";
  sizes: string[];
} {
  // Assets ship as a sibling of dist/ in the npm package; we resolve from
  // this file's URL so it works in both `node dist/index.js` and the
  // `npx vetroscope-mcp` install layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  const buf = readFileSync(join(here, "..", "assets", filename));
  return {
    src: `data:image/png;base64,${buf.toString("base64")}`,
    mimeType: "image/png",
    sizes,
  };
}

const SERVER_ICONS = [
  loadIcon("icon-128.png", ["128x128"]),
  loadIcon("icon-256.png", ["256x256"]),
];

const server = new McpServer({
  name: "vetroscope-mcp",
  version: "0.1.1",
  title: "Vetroscope",
  description:
    "Read-only access to your local Vetroscope time-tracking database — apps, projects, goals, and individual sessions.",
  websiteUrl: "https://rankin.works",
  icons: SERVER_ICONS,
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
      "Aggregate Vetroscope time report for a period: total active seconds, top apps, and top projects (with sub-projects nested when present — e.g. individual YouTube videos, SoundCloud songs, Netflix episodes). Apps include the user's custom display_name when set. Mirrors the desktop dashboard.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      top_apps: z.number().int().min(1).max(500).optional().describe("Max apps returned (default 50)"),
      top_projects: z.number().int().min(1).max(500).optional().describe("Max projects returned (default 50)"),
      top_sub_projects: z.number().int().min(0).max(200).optional().describe("Max sub-projects per project (default 25, 0 to omit)"),
    },
  },
  async ({ period, top_apps, top_projects, top_sub_projects }) =>
    asJson(getReport(db(), period, {
      topApps: top_apps, topProjects: top_projects, topSubProjects: top_sub_projects,
    }))
);

server.registerTool(
  "get_app_breakdown",
  {
    title: "Get per-app breakdown",
    description:
      "Per-project breakdown for a single app over a period, with sub-projects nested when present (e.g. individual YouTube videos under the YouTube project). Use this when the user asks 'what was I working on in After Effects this week?' or 'which YouTube videos did I watch today?'",
    inputSchema: {
      app: z.string().describe("Exact app name as recorded by Vetroscope (e.g. 'After Effects', 'Cursor'). Match the canonical name, not the user's custom display_name."),
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      limit: z.number().int().min(1).max(500).optional().describe("Max projects returned (default 100)"),
      top_sub_projects: z.number().int().min(0).max(200).optional().describe("Max sub-projects per project (default 25, 0 to omit)"),
    },
  },
  async ({ app, period, limit, top_sub_projects }) =>
    asJson(getAppBreakdown(db(), app, period, limit, top_sub_projects))
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
      "Filtered list of raw tracking entries. Useful for digging into specific projects or finding what window titles appeared. Defaults to active foreground entries only — pass mode='passive' or 'all' to include away-listening (background music while idle). Returns at most 5000 rows; default 200.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).optional(),
      app: z.string().optional().describe("Restrict to a single app name"),
      project: z.string().optional().describe("Restrict to a single project (exact match)"),
      search: z.string().optional().describe("Substring match against window title, project, or sub-project"),
      mode: z
        .enum(["active", "passive", "all"]).optional()
        .describe("active = foreground only (default), passive = away-listening only, all = both"),
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
