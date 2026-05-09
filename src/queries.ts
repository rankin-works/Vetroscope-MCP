import type Database from "better-sqlite3";
import { parsePeriod, type Range } from "./periods.js";

/**
 * Vetroscope polls every 30s. The dashboard computes durations as the count
 * of distinct 30s buckets that contain at least one foreground entry — this
 * matches the desktop app's reported totals exactly. Source of truth lives
 * in `electron/database.ts` (POLL_INTERVAL_SECONDS).
 */
const POLL_SECONDS = 30;
const BUCKET_EXPR = `(CAST(strftime('%s', e.timestamp) AS INTEGER) / ${POLL_SECONDS})`;

/**
 * Distinct-bucket seconds: number of 30s windows where this group had a
 * sample, multiplied back out to seconds. Used everywhere we want totals
 * that line up with the Vetroscope UI rather than naive `COUNT(*) * 30`.
 */
const SECONDS_EXPR = `COUNT(DISTINCT ${BUCKET_EXPR}) * ${POLL_SECONDS}`;

/** Read JSON-encoded settings the desktop app stores as TEXT. */
function readJsonSetting<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function getIgnoredApps(db: Database.Database): string[] {
  const v = readJsonSetting<unknown>(db, "ignored_apps", []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function ignoredAppsClause(ignored: string[], alias = "e"): { clause: string; params: string[] } {
  if (ignored.length === 0) return { clause: "", params: [] };
  const placeholders = ignored.map(() => "?").join(",");
  return {
    clause: ` AND ${alias}.app_name NOT IN (${placeholders})`,
    params: ignored,
  };
}

// ── get_report ───────────────────────────────────────────────────────────

export interface AppTotal {
  app: string;
  seconds: number;
}

export interface ProjectTotal {
  app: string;
  project: string;
  seconds: number;
}

export interface ReportResult {
  period: string;
  label: string;
  sublabel: string;
  start: string;
  end: string;
  totalSeconds: number;
  apps: AppTotal[];
  projects: ProjectTotal[];
}

export function getReport(
  db: Database.Database,
  period: string,
  opts: { topApps?: number; topProjects?: number } = {}
): ReportResult {
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${iC}`;
  const baseParams = [range.start, range.end, ...iP];

  const totalRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}`
    )
    .get(...baseParams) as { seconds: number | null };

  const apps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}
        GROUP BY e.app_name
        ORDER BY seconds DESC
        LIMIT ?`
    )
    .all(...baseParams, opts.topApps ?? 50) as AppTotal[];

  const projects = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}
          AND e.project IS NOT NULL
          AND e.project != ''
        GROUP BY e.app_name, e.project
        ORDER BY seconds DESC
        LIMIT ?`
    )
    .all(...baseParams, opts.topProjects ?? 50) as ProjectTotal[];

  return {
    period,
    label: range.label,
    sublabel: range.sublabel,
    start: range.start,
    end: range.end,
    totalSeconds: totalRow.seconds ?? 0,
    apps,
    projects,
  };
}

// ── get_app_breakdown ────────────────────────────────────────────────────

export interface AppBreakdownResult extends Range {
  app: string;
  totalSeconds: number;
  projects: ProjectTotal[];
}

export function getAppBreakdown(
  db: Database.Database,
  app: string,
  period: string,
  limit = 100
): AppBreakdownResult {
  const range = parsePeriod(period);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?`;
  const params = [range.start, range.end, app];

  const total = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${where}`)
    .get(...params) as { seconds: number | null };

  const projects = db
    .prepare(
      `SELECT e.app_name AS app, COALESCE(e.project, '') AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}
        GROUP BY e.project
        ORDER BY seconds DESC
        LIMIT ?`
    )
    .all(...params, limit) as ProjectTotal[];

  return {
    ...range,
    app,
    totalSeconds: total.seconds ?? 0,
    projects,
  };
}

// ── get_goals_progress ───────────────────────────────────────────────────

export type GoalType = "app" | "overall" | "tag";

export interface GoalProgress {
  id: number;
  type: GoalType;
  app: string | null;
  tagId: number | null;
  tagName: string | null;
  targetSeconds: number;
  currentSeconds: number;
  percent: number;
  enabled: boolean;
  achieved: boolean;
}

interface GoalRow {
  id: number;
  type: GoalType;
  app: string | null;
  tagId: number | null;
  tagName: string | null;
  targetSeconds: number;
  enabled: number;
}

function goalsTableHasTagId(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(goals)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "tag_id");
}

export function getGoalsProgress(db: Database.Database, period = "today"): GoalProgress[] {
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const hasTagId = goalsTableHasTagId(db);

  // `goals.tag_id` only exists in DBs migrated past the tag-goals release.
  // Older installs won't have the column, so we fall back gracefully.
  const goals = db
    .prepare(
      hasTagId
        ? `SELECT g.id, g.type, g.app_name AS app, g.tag_id AS tagId,
                  t.name AS tagName, g.target_seconds AS targetSeconds, g.enabled
             FROM goals g
             LEFT JOIN tags t ON t.id = g.tag_id
            ORDER BY g.type, g.app_name, t.name`
        : `SELECT id, type, app_name AS app, NULL AS tagId, NULL AS tagName,
                  target_seconds AS targetSeconds, enabled
             FROM goals
            ORDER BY type, app`
    )
    .all() as GoalRow[];

  return goals.map((g): GoalProgress => {
    let current = 0;
    if (g.type === "overall") {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ?${iC}`
        )
        .get(range.start, range.end, ...iP) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "tag" && g.tagId != null) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.tag_id = ?`
        )
        .get(range.start, range.end, g.tagId) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "app" && g.app) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?`
        )
        .get(range.start, range.end, g.app) as { seconds: number | null };
      current = row.seconds ?? 0;
    }
    const percent = g.targetSeconds > 0 ? (current / g.targetSeconds) * 100 : 0;
    return {
      id: g.id,
      type: g.type,
      app: g.app,
      tagId: g.tagId,
      tagName: g.tagName,
      targetSeconds: g.targetSeconds,
      currentSeconds: current,
      percent: Math.round(percent * 10) / 10,
      enabled: g.enabled === 1,
      achieved: current >= g.targetSeconds,
    };
  });
}

// ── query_entries ────────────────────────────────────────────────────────

export interface EntryRow {
  id: number;
  timestamp: string;
  app: string;
  windowTitle: string | null;
  project: string | null;
  subProject: string | null;
  tagId: number | null;
  tagName: string | null;
}

export interface QueryEntriesArgs {
  period?: string;
  app?: string;
  project?: string;
  search?: string;
  limit?: number;
}

export function queryEntries(db: Database.Database, args: QueryEntriesArgs): EntryRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (args.period) {
    const range = parsePeriod(args.period);
    where.push("e.timestamp >= ?");
    where.push("e.timestamp < ?");
    params.push(range.start, range.end);
  }
  if (args.app) {
    where.push("e.app_name = ?");
    params.push(args.app);
  }
  if (args.project) {
    where.push("e.project = ?");
    params.push(args.project);
  }
  if (args.search) {
    where.push("(e.window_title LIKE ? OR e.project LIKE ? OR e.sub_project LIKE ?)");
    const term = `%${args.search}%`;
    params.push(term, term, term);
  }

  const limit = Math.min(Math.max(args.limit ?? 200, 1), 5000);
  const sql = `
    SELECT e.id, e.timestamp, e.app_name AS app, e.window_title AS windowTitle,
           e.project, e.sub_project AS subProject, e.tag_id AS tagId,
           t.name AS tagName
      FROM entries e
      LEFT JOIN tags t ON t.id = e.tag_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY e.timestamp DESC
     LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit) as EntryRow[];
}
