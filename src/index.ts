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
  listTags,
  getTagBreakdown,
  getTagStats,
  getAppStats,
  listMarkers,
  getSessions,
  getCurrentStatus,
  getGoalAchievements,
  listProjects,
  getCalendar,
  getDeviceBreakdown,
  getMusicSplit,
  getCategoryBreakdown,
  getListeningHistory,
  getFocusHeatmap,
  getMediaLinks,
  DEFAULT_MUSIC_APPS,
  DEFAULT_MUSIC_BROWSER_PROJECTS,
  type TimeFilters,
} from "./queries.js";

const PERIOD_DESCRIPTION =
  "today | yesterday | week | month | year | a single date YYYY-MM-DD | an inclusive date range YYYY-MM-DD..YYYY-MM-DD";

// Shared zod fragments for the optional hour-of-day / weekday time filter.
const HOUR_START_DESC = "Inclusive start hour 0-24 in local time. Combine with hour_end (e.g. 9 and 17 = 9am to 4:59pm). Omit both for no hour filter.";
const HOUR_END_DESC = "Exclusive end hour 0-24 in local time. Combine with hour_start.";
const WEEKDAYS_DESC = "Restrict to specific weekdays. 0=Sunday, 1=Monday, …, 6=Saturday. Omit or pass [0,1,2,3,4,5,6] for no weekday filter.";
const DEVICE_DESC = "Restrict to a single device. Pass 'current' (or 'this') for the local machine, a device UUID from get_device_breakdown, or a platform name like 'darwin', 'win32', 'browser-extension'. Omit or pass 'all' for no device filter.";

function pickTimeFilters(args: {
  hour_start?: number; hour_end?: number; weekdays?: number[];
}): TimeFilters | undefined {
  const tf: TimeFilters = {};
  if (typeof args.hour_start === "number") tf.hourStart = args.hour_start;
  if (typeof args.hour_end === "number") tf.hourEnd = args.hour_end;
  if (Array.isArray(args.weekdays)) tf.weekdays = args.weekdays;
  return Object.keys(tf).length === 0 ? undefined : tf;
}

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
  version: "1.2.0",
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
      "Aggregate Vetroscope time report for a period: total active seconds, top apps, and top projects (with sub-projects nested when present — e.g. individual YouTube videos, SoundCloud songs, Netflix episodes). Apps include the user's custom display_name when set. Applies the same SQLite settings as the desktop dashboard — ignored apps, ignored projects/breakdown patterns, and days_filter — plus optional hour-of-day/weekday/device filters layered on top. Totals therefore match Charts/Dashboard totals for the same range.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      top_apps: z.number().int().min(0).max(500).optional().describe("Max apps returned (default 50, 0 to omit)"),
      top_projects: z.number().int().min(0).max(500).optional().describe("Max projects returned (default 50, 0 to omit)"),
      top_sub_projects: z.number().int().min(0).max(200).optional().describe("Max sub-projects per project (default 25, 0 to omit)"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getReport(db(), args.period, {
      topApps: args.top_apps,
      topProjects: args.top_projects,
      topSubProjects: args.top_sub_projects,
      timeFilters: pickTimeFilters(args),
      device: args.device,
    }))
);

server.registerTool(
  "get_app_breakdown",
  {
    title: "Get per-app breakdown",
    description:
      "Per-project breakdown for a single app over a period, with sub-projects nested when present (e.g. individual YouTube videos under the YouTube project). Use this when the user asks 'what was I working on in After Effects this week?' or 'which YouTube videos did I watch today?' Supports the same hour-of-day / weekday filter as get_report.",
    inputSchema: {
      app: z.string().describe("Exact app name as recorded by Vetroscope (e.g. 'After Effects', 'Cursor'). Match the canonical name, not the user's custom display_name."),
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      limit: z.number().int().min(1).max(500).optional().describe("Max projects returned (default 100)"),
      top_sub_projects: z.number().int().min(0).max(200).optional().describe("Max sub-projects per project (default 25, 0 to omit)"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getAppBreakdown(db(), args.app, args.period, args.limit, args.top_sub_projects, pickTimeFilters(args), args.device))
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
      "Filtered list of raw tracking entries. Useful for digging into specific projects, tags, or finding what window titles appeared. When a period is set, respects the same dashboard exclusions stored in SQLite (ignored apps/projects/breakdown patterns, days_filter) plus optional hour/device filters so aggregates stay consistent with Charts; omit period to bypass those scope rules while still filtering by tag/app/search/etc. Defaults to active foreground entries only — pass mode='passive' or 'all' to include away-listening (background music while idle). Returns at most 5000 rows; default 200.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).optional(),
      app: z.string().optional().describe("Restrict to a single app name (canonical name, not display_name)"),
      project: z.string().optional().describe("Restrict to a single project (exact match)"),
      tag: z.string().optional().describe("Restrict to entries carrying a tag with this exact name"),
      search: z.string().optional().describe("Substring match against window title, project, or sub-project"),
      mode: z
        .enum(["active", "passive", "all"]).optional()
        .describe("active = foreground only (default), passive = away-listening only, all = both"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
      limit: z.number().int().min(1).max(5000).optional(),
    },
  },
  async (args) => asJson(queryEntries(db(), {
    period: args.period,
    app: args.app,
    project: args.project,
    tag: args.tag,
    search: args.search,
    mode: args.mode,
    timeFilters: pickTimeFilters(args),
    device: args.device,
    limit: args.limit,
  }))
);

server.registerTool(
  "list_tags",
  {
    title: "List tags",
    description:
      "List the user's tags (id, name, color, sticky flag, archived flag, and parentId/parentName for nested tags). Archived tags are hidden by default — set include_archived to see them. Useful as a reference before calling get_tag_breakdown / get_tag_stats or filtering entries by tag.",
    inputSchema: {
      include_archived: z.boolean().optional().describe("Include archived tags (hidden by default, matching the app)."),
    },
  },
  async ({ include_archived }) => asJson(listTags(db(), { includeArchived: include_archived }))
);

server.registerTool(
  "get_tag_breakdown",
  {
    title: "Get tag breakdown",
    description:
      "Time-spent report for a single tag over a period: top apps and projects under the tag, daily series, active/passive split. Identify the tag by name (case-insensitive) — call list_tags first if you don't already know what's available.",
    inputSchema: {
      tag: z.string().describe("Tag name (case-insensitive). Numeric strings are treated as tag IDs."),
      period: z.string().describe(PERIOD_DESCRIPTION).default("week"),
      top_apps: z.number().int().min(0).max(500).optional().describe("Max apps returned (default 50, 0 to omit)"),
      top_projects: z.number().int().min(0).max(500).optional().describe("Max projects returned (default 50, 0 to omit)"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) => {
    // Allow numeric strings to address by id, otherwise resolve by name.
    const idMaybe = /^\d+$/.test(args.tag) ? Number(args.tag) : args.tag;
    const result = getTagBreakdown(db(), idMaybe, args.period, {
      topApps: args.top_apps,
      topProjects: args.top_projects,
      timeFilters: pickTimeFilters(args),
      device: args.device,
    });
    if (!result) {
      return {
        content: [{ type: "text" as const, text: `No tag found matching "${args.tag}". Call list_tags to see available tags.` }],
        isError: true,
      };
    }
    return asJson(result);
  }
);

server.registerTool(
  "get_tag_stats",
  {
    title: "Get tag statistics",
    description:
      "Deeper statistics for a single tag — the tag counterpart to get_app_stats. Lifetime totals (days active, first/last seen, average per active day), period totals, top apps under the tag, daily series, hour-of-day (24 buckets) and weekday (7 buckets) distributions, plus the tag's place in the hierarchy: its parent and its immediate children with rolled-up totals. The tag's own totals count directly-assigned time only; children are reported separately. Identify the tag by name (case-insensitive) or numeric id — call list_tags first if unsure.",
    inputSchema: {
      tag: z.string().describe("Tag name (case-insensitive). Numeric strings are treated as tag IDs."),
      period: z.string().describe(PERIOD_DESCRIPTION + ". Defaults to 'week'.").default("week"),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async ({ tag, period, device }) => {
    const idMaybe = /^\d+$/.test(tag) ? Number(tag) : tag;
    const result = getTagStats(db(), idMaybe, period, device);
    if (!result) {
      return {
        content: [{ type: "text" as const, text: `No tag found matching "${tag}". Call list_tags to see available tags.` }],
        isError: true,
      };
    }
    return asJson(result);
  }
);

server.registerTool(
  "get_app_stats",
  {
    title: "Get app statistics",
    description:
      "Deeper statistics for a single app: lifetime totals (days active, first/last seen, average per active day), period totals, top projects, daily series, hour-of-day distribution (24 buckets), and weekday distribution (7 buckets). Use this for usage-pattern questions like 'when do I usually use Cursor?' or 'how has my After Effects time trended this month?'",
    inputSchema: {
      app: z.string().describe("Exact app name as recorded by Vetroscope (canonical, not display_name)."),
      period: z.string().describe(PERIOD_DESCRIPTION + ". Defaults to 'week'.").default("week"),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async ({ app, period, device }) => {
    const result = getAppStats(db(), app, period, device);
    if (!result) {
      return {
        content: [{ type: "text" as const, text: `No entries found for app "${app}". Use get_report to see canonical app names.` }],
        isError: true,
      };
    }
    return asJson(result);
  }
);

server.registerTool(
  "list_markers",
  {
    title: "List timeline markers",
    description:
      "User-placed markers on the Vetroscope timeline (timestamp, optional end_timestamp for regions, label, color, icon). Pass a period to scope to a window — markers whose region OVERLAPS the period are returned. Omit period to list every marker.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).optional(),
    },
  },
  async ({ period }) => asJson(listMarkers(db(), period))
);

server.registerTool(
  "get_sessions",
  {
    title: "Get activity sessions",
    description:
      "Continuous activity blocks reconstructed from the raw 30s entries — the natural grain for 'what did I work on this morning?'. Two consecutive entries are one session when they share the same (app, project, sub_project) and are within 90s of each other. Each session reports start/end/duration and tag/app metadata.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("today"),
      app: z.string().optional().describe("Restrict to a single app (canonical name)"),
      project: z.string().optional().describe("Restrict to a single project (exact match)"),
      tag: z.string().optional().describe("Restrict to entries carrying a tag with this exact name"),
      min_seconds: z.number().int().min(0).max(86400).optional().describe("Drop sessions shorter than this (default 0 — keep all)"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
      limit: z.number().int().min(1).max(5000).optional().describe("Max sessions returned (default 200)"),
    },
  },
  async (args) =>
    asJson(getSessions(db(), args.period, {
      app: args.app, project: args.project, tag: args.tag, device: args.device,
      minSeconds: args.min_seconds, limit: args.limit,
      timeFilters: pickTimeFilters(args),
    }))
);

server.registerTool(
  "get_current_status",
  {
    title: "Get current tracking status",
    description:
      "Most recent activity: what app / project / sub-project the tracker last logged, how many seconds ago, and whether the tracker appears to be live (state='tracking') or quiescent (state='idle'). Use this for 'what am I doing right now?' questions.",
    inputSchema: {},
  },
  async () => asJson(getCurrentStatus(db()))
);

server.registerTool(
  "get_goal_achievements",
  {
    title: "Get goal achievement history",
    description:
      "Historical record of goals the user hit — one row per (goal, day). Each row carries a snapshot of the goal as it was when achieved (so renamed/deleted goals still report sensibly). Useful for streak questions ('how many days in a row…') or summaries ('which goals did I hit last week?').",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("month"),
    },
  },
  async ({ period }) => asJson(getGoalAchievements(db(), period))
);

server.registerTool(
  "list_projects",
  {
    title: "List all projects",
    description:
      "Every (app, project) pair ever recorded with all-time totals, days active, and first/last seen. Optional case-insensitive substring search against project name or app. Useful for 'have I ever worked on something called X?' or 'what's my biggest project all-time?'",
    inputSchema: {
      search: z.string().optional().describe("Case-insensitive substring match against project name or app name"),
      limit: z.number().int().min(1).max(5000).optional().describe("Max projects returned (default 200)"),
    },
  },
  async (args) => asJson(listProjects(db(), args))
);

server.registerTool(
  "get_calendar",
  {
    title: "Get daily totals (calendar / heatmap)",
    description:
      "Dense per-day series of active and passive seconds for a period. Default period is 'year' for the GitHub-contribution-grid heatmap; pass any other period for narrower windows. Days with zero activity are explicitly included so streak / longest-gap analysis is straightforward.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION + ". Defaults to 'year'.").default("year"),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async ({ period, device }) => asJson(getCalendar(db(), period, device))
);

server.registerTool(
  "get_device_breakdown",
  {
    title: "Get per-device time breakdown",
    description:
      "Time per device for users who run Vetroscope across multiple machines (or paired with the browser extension). Each device reports total active / passive seconds, days active, first/last seen, and most-frequent platform. The user's current device is flagged with isCurrent=true.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("month"),
    },
  },
  async ({ period }) => asJson(getDeviceBreakdown(db(), period))
);

server.registerTool(
  "get_music_split",
  {
    title: "Get music vs work split",
    description:
      "Splits the period's tracked time into three buckets: 'work with music' (a music app/site was logging while a non-music app was foreground), 'music only' (just listening, no work foreground), and 'work without music' (heads-down silent work). Also returns per-source totals (Spotify, SoundCloud, etc.) with each source's working-vs-not-working overlap. Music classification defaults to native music apps (Spotify, Apple Music) plus common browser music sites (SoundCloud, YouTube Music, Bandcamp, Tidal, Pandora) — override via music_apps / music_browser_projects to e.g. include YouTube as music for a specific question. The same hour-of-day / weekday / device filters as get_report are honored.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("week"),
      music_apps: z.array(z.string()).optional()
        .describe(`Override the native music app list. Default: ${JSON.stringify(DEFAULT_MUSIC_APPS)}`),
      music_browser_projects: z.array(z.string()).optional()
        .describe(`Override the browser-music project list. Default: ${JSON.stringify(DEFAULT_MUSIC_BROWSER_PROJECTS)}. Add 'YouTube' here if you want YouTube counted as music for this query.`),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getMusicSplit(db(), args.period, {
      musicApps: args.music_apps,
      musicBrowserProjects: args.music_browser_projects,
      timeFilters: pickTimeFilters(args),
      device: args.device,
    }))
);

server.registerTool(
  "get_category_breakdown",
  {
    title: "Get time by app category",
    description:
      "Rolls up app totals into broad categories (editor, browser, adobe, communication, gaming, productivity, creative, music_creation, etc.) so you can ask 'how much creative work vs coding?' without naming every app. Categories mirror Vetroscope's internal app grouping. Apps not in the canonical map land in 'uncategorized' — useful for spotting missing classifications.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("week"),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getCategoryBreakdown(db(), args.period, {
      timeFilters: pickTimeFilters(args),
      device: args.device,
    }))
);

server.registerTool(
  "get_listening_history",
  {
    title: "Get listening history",
    description:
      "Top tracks and top artists across native music apps and browser music sites for the period, plus per-day listening minutes. Tracks come from entries.sub_project (e.g. 'Fox Stevenson — Tryhard'); artists are parsed from the 'Artist — Title' convention. Same music classifier as get_music_split — override via music_apps / music_browser_projects to e.g. include YouTube as music for this query.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("week"),
      top_tracks: z.number().int().min(0).max(500).optional().describe("Max tracks returned (default 50, 0 to omit)"),
      top_artists: z.number().int().min(0).max(200).optional().describe("Max artists returned (default 25, 0 to omit)"),
      music_apps: z.array(z.string()).optional()
        .describe(`Override the native music app list. Default: ${JSON.stringify(DEFAULT_MUSIC_APPS)}`),
      music_browser_projects: z.array(z.string()).optional()
        .describe(`Override the browser-music project list. Default: ${JSON.stringify(DEFAULT_MUSIC_BROWSER_PROJECTS)}`),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getListeningHistory(db(), args.period, {
      topTracks: args.top_tracks,
      topArtists: args.top_artists,
      musicApps: args.music_apps,
      musicBrowserProjects: args.music_browser_projects,
      timeFilters: pickTimeFilters(args),
      device: args.device,
    }))
);

server.registerTool(
  "get_media_links",
  {
    title: "Get captured media URLs (Spotify tracks, YouTube videos)",
    description:
      "Lists canonical deep-links Vetroscope captured for media the user actually played — Spotify `spotify:track:…` URIs and YouTube `https://www.youtube.com/watch?v=…` URLs. Each row carries the matching time data so you can answer 'what YouTube videos did I rewatch this week + give me the link to the top one?' or 'send me a Spotify URI for the song I played the most yesterday'. Each row also includes a `webUrl` HTTPS variant — `https://open.spotify.com/track/<id>` for Spotify (which hands off to the desktop app when installed), same as `url` for YouTube — so a clickable link survives any markdown / chat renderer that strips custom URI schemes. Requires Vetroscope ≥ 0.2.30 with the `capture_media_links` setting enabled — `available: false` is returned on older installs or when nothing has been captured. With `period` set, the same dashboard filter stack as get_report applies and totals match Charts; without `period`, time columns are lifetime totals. URLs are filtered strictly at capture time (YouTube /watch only; track URIs only — no ads, no shorts, no channel pages) so anything returned here is safe to open directly.",
    inputSchema: {
      kind: z.enum(["spotify_track", "youtube_watch"]).optional()
        .describe("Restrict to one kind. Omit to return both."),
      period: z.string().describe(PERIOD_DESCRIPTION + ". Omit for lifetime totals.").optional(),
      search: z.string().optional()
        .describe("Case-insensitive substring match against project, sub-project, or app name. Useful for 'find the Beyoncé track' style lookups."),
      limit: z.number().int().min(1).max(500).optional().describe("Max links returned (default 100). Sorted by total time within the period desc."),
      hour_start: z.number().int().min(0).max(24).optional().describe(HOUR_START_DESC),
      hour_end: z.number().int().min(0).max(24).optional().describe(HOUR_END_DESC),
      weekdays: z.array(z.number().int().min(0).max(6)).optional().describe(WEEKDAYS_DESC),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getMediaLinks(db(), {
      kind: args.kind,
      period: args.period,
      search: args.search,
      limit: args.limit,
      timeFilters: pickTimeFilters(args),
      device: args.device,
    }))
);

server.registerTool(
  "get_focus_heatmap",
  {
    title: "Get focus heatmap (hour × weekday grid)",
    description:
      "Returns a dense 168-cell grid (7 weekdays × 24 hours) of active foreground seconds. Reveals when you usually do specific kinds of work — patterns the marginal hour-of-day and weekday distributions can't show. Optional app / project / tag filters narrow the heatmap to a single activity (e.g. 'when do I usually code in Cursor?'). Cells array is in (weekday, hour) order so cells[w*24 + h] indexes directly. 0=Sunday in weekday.",
    inputSchema: {
      period: z.string().describe(PERIOD_DESCRIPTION).default("month"),
      app: z.string().optional().describe("Restrict to a single app (canonical name)"),
      project: z.string().optional().describe("Restrict to a single project (exact match)"),
      tag: z.string().optional().describe("Restrict to entries carrying a tag with this exact name"),
      device: z.string().optional().describe(DEVICE_DESC),
    },
  },
  async (args) =>
    asJson(getFocusHeatmap(db(), args.period, {
      app: args.app, project: args.project, tag: args.tag, device: args.device,
    }))
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
