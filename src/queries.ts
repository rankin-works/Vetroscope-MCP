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

/**
 * Passive entries (`is_passive = 1`) are away-listening: music that kept
 * playing while the user was idle. Vetroscope records them so listening
 * history stays intact but **excludes them from work / app-time totals**
 * so daily totals don't inflate. We mirror that: `totalSeconds` /
 * `seconds` always mean active foreground time; passive time is exposed
 * as a parallel `passiveSeconds` field.
 *
 * Some pre-passive-migration DBs may not have the `is_passive` column at
 * all. We detect this once per-connection and fall back to "everything
 * is active" so the MCP still works on those installs.
 */
const ACTIVE_ONLY = " AND e.is_passive = 0";
const PASSIVE_ONLY = " AND e.is_passive = 1";

let _hasPassiveColumn: WeakMap<Database.Database, boolean> = new WeakMap();
function hasPassiveColumn(db: Database.Database): boolean {
  const cached = _hasPassiveColumn.get(db);
  if (cached !== undefined) return cached;
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const has = cols.some((c) => c.name === "is_passive");
  _hasPassiveColumn.set(db, has);
  return has;
}

function activeFilter(db: Database.Database): string {
  return hasPassiveColumn(db) ? ACTIVE_ONLY : "";
}
function passiveFilter(db: Database.Database): string {
  // If the DB pre-dates is_passive, nothing is passive.
  return hasPassiveColumn(db) ? PASSIVE_ONLY : " AND 0 = 1";
}

let _hasSubProjectColumn: WeakMap<Database.Database, boolean> = new WeakMap();
function hasSubProjectColumn(db: Database.Database): boolean {
  const cached = _hasSubProjectColumn.get(db);
  if (cached !== undefined) return cached;
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const has = cols.some((c) => c.name === "sub_project");
  _hasSubProjectColumn.set(db, has);
  return has;
}

let _hasAppOverridesTable: WeakMap<Database.Database, boolean> = new WeakMap();
function hasAppOverridesTable(db: Database.Database): boolean {
  const cached = _hasAppOverridesTable.get(db);
  if (cached !== undefined) return cached;
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_overrides'`)
    .get();
  const has = !!row;
  _hasAppOverridesTable.set(db, has);
  return has;
}

/**
 * `app_overrides.display_name` lets users rename apps in the Vetroscope UI
 * (e.g. raw "Code" → "VS Code"). We surface the override as `displayName`
 * alongside the canonical `app` name so consumers can show whichever the
 * user expects without losing the join key.
 */
function loadDisplayNames(db: Database.Database): Map<string, string> {
  const map = new Map<string, string>();
  if (!hasAppOverridesTable(db)) return map;
  const rows = db
    .prepare(`SELECT app_name, display_name FROM app_overrides WHERE display_name IS NOT NULL AND display_name != ''`)
    .all() as Array<{ app_name: string; display_name: string }>;
  for (const r of rows) map.set(r.app_name, r.display_name);
  return map;
}

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
  /**
   * User-set custom name from `app_overrides.display_name`, when present.
   * Null when the user hasn't renamed this app — fall back to `app`.
   */
  displayName: string | null;
  /** Active foreground seconds. */
  seconds: number;
  /** Background away-listening seconds (e.g. Spotify while idle). 0 for non-music apps. */
  passiveSeconds: number;
}

export interface SubProjectTotal {
  /** e.g. a YouTube video title, a SoundCloud song, a Netflix episode. */
  subProject: string;
  /** Active foreground seconds for this sub-project. */
  seconds: number;
  /** Background away-listening seconds (e.g. video kept playing while idle). */
  passiveSeconds: number;
}

export interface ProjectTotal {
  app: string;
  /** Custom app display name when set, else null. */
  displayName: string | null;
  project: string;
  /** Active foreground seconds for this project. */
  seconds: number;
  /** Background seconds (e.g. a YouTube video that kept playing while idle). */
  passiveSeconds: number;
  /**
   * Third-tier breakdown: individual videos / songs / episodes inside this
   * project, sorted by total time desc. Empty when the entries don't carry
   * sub-project data (most native-tracked apps leave this null — only the
   * browser-extension media tracker populates it today).
   */
  subProjects: SubProjectTotal[];
}

export interface ReportResult {
  period: string;
  label: string;
  sublabel: string;
  start: string;
  end: string;
  /** Active foreground seconds across all apps — matches the Vetroscope dashboard headline. */
  totalSeconds: number;
  /** Background away-listening seconds across all apps. */
  totalPassiveSeconds: number;
  apps: AppTotal[];
  projects: ProjectTotal[];
}

export function getReport(
  db: Database.Database,
  period: string,
  opts: { topApps?: number; topProjects?: number; topSubProjects?: number } = {}
): ReportResult {
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${iC}`;
  const baseParams = [range.start, range.end, ...iP];
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);
  const dn = (app: string) => displayNames.get(app) ?? null;

  const totalRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${active}`
    )
    .get(...baseParams) as { seconds: number | null };

  const passiveTotalRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${passive}`
    )
    .get(...baseParams) as { seconds: number | null };

  const activeApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${active}
        GROUP BY e.app_name`
    )
    .all(...baseParams) as Array<{ app: string; seconds: number }>;

  const passiveApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${passive}
        GROUP BY e.app_name`
    )
    .all(...baseParams) as Array<{ app: string; seconds: number }>;

  // Merge the two app rollups so apps with only-passive time (background
  // music while idle) still appear in the breakdown.
  const appMap = new Map<string, AppTotal>();
  for (const r of activeApps) {
    appMap.set(r.app, { app: r.app, displayName: dn(r.app), seconds: r.seconds, passiveSeconds: 0 });
  }
  for (const r of passiveApps) {
    const existing = appMap.get(r.app);
    if (existing) existing.passiveSeconds = r.seconds;
    else appMap.set(r.app, { app: r.app, displayName: dn(r.app), seconds: 0, passiveSeconds: r.seconds });
  }
  const apps = [...appMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
    .slice(0, opts.topApps ?? 50);

  // Same merge for projects. Vetroscope's project breakdowns intentionally
  // include passive entries so songs heard in the background still show up.
  const activeProjects = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${active}
          AND e.project IS NOT NULL AND e.project != ''
        GROUP BY e.app_name, e.project`
    )
    .all(...baseParams) as Array<{ app: string; project: string; seconds: number }>;

  const passiveProjects = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${passive}
          AND e.project IS NOT NULL AND e.project != ''
        GROUP BY e.app_name, e.project`
    )
    .all(...baseParams) as Array<{ app: string; project: string; seconds: number }>;

  const projMap = new Map<string, ProjectTotal>();
  const pkey = (app: string, project: string) => `${app}\0${project}`;
  for (const r of activeProjects) {
    projMap.set(pkey(r.app, r.project), {
      app: r.app, displayName: dn(r.app), project: r.project,
      seconds: r.seconds, passiveSeconds: 0, subProjects: [],
    });
  }
  for (const r of passiveProjects) {
    const k = pkey(r.app, r.project);
    const existing = projMap.get(k);
    if (existing) existing.passiveSeconds = r.seconds;
    else projMap.set(k, {
      app: r.app, displayName: dn(r.app), project: r.project,
      seconds: 0, passiveSeconds: r.seconds, subProjects: [],
    });
  }

  // Roll up sub-projects (YouTube videos, SoundCloud songs, Netflix
  // episodes, …) per (app, project) and attach them to the matching
  // project rows. Skipped on pre-sub-project DBs.
  attachSubProjects(db, projMap, baseWhere, baseParams, opts.topSubProjects ?? 25);

  const projects = [...projMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
    .slice(0, opts.topProjects ?? 50);

  return {
    period,
    label: range.label,
    sublabel: range.sublabel,
    start: range.start,
    end: range.end,
    totalSeconds: totalRow.seconds ?? 0,
    totalPassiveSeconds: passiveTotalRow.seconds ?? 0,
    apps,
    projects,
  };
}

/**
 * Populate `subProjects` on each entry of `projMap`. Mutates in place.
 * `whereClause` and `whereParams` describe the time/ignored filter — same
 * shape used by the parent project query so the totals line up.
 */
function attachSubProjects(
  db: Database.Database,
  projMap: Map<string, ProjectTotal>,
  whereClause: string,
  whereParams: (string | number)[],
  perProjectLimit: number,
): void {
  if (!hasSubProjectColumn(db)) return;
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const subBase = `${whereClause} AND e.project IS NOT NULL AND e.project != '' AND e.sub_project IS NOT NULL AND e.sub_project != ''`;

  const activeSubs = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, e.sub_project AS subProject, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${subBase}${active}
        GROUP BY e.app_name, e.project, e.sub_project`
    )
    .all(...whereParams) as Array<{ app: string; project: string; subProject: string; seconds: number }>;

  const passiveSubs = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, e.sub_project AS subProject, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${subBase}${passive}
        GROUP BY e.app_name, e.project, e.sub_project`
    )
    .all(...whereParams) as Array<{ app: string; project: string; subProject: string; seconds: number }>;

  const subMap = new Map<string, Map<string, SubProjectTotal>>(); // projKey → subKey → totals
  const pkey = (a: string, p: string) => `${a}\0${p}`;
  const ensure = (a: string, p: string) => {
    const k = pkey(a, p);
    let inner = subMap.get(k);
    if (!inner) { inner = new Map(); subMap.set(k, inner); }
    return inner;
  };
  for (const r of activeSubs) {
    ensure(r.app, r.project).set(r.subProject, {
      subProject: r.subProject, seconds: r.seconds, passiveSeconds: 0,
    });
  }
  for (const r of passiveSubs) {
    const inner = ensure(r.app, r.project);
    const existing = inner.get(r.subProject);
    if (existing) existing.passiveSeconds = r.seconds;
    else inner.set(r.subProject, { subProject: r.subProject, seconds: 0, passiveSeconds: r.seconds });
  }

  for (const [projKey, project] of projMap) {
    const inner = subMap.get(projKey);
    if (!inner) continue;
    project.subProjects = [...inner.values()]
      .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
      .slice(0, perProjectLimit);
  }
}

// ── get_app_breakdown ────────────────────────────────────────────────────

export interface AppBreakdownResult extends Range {
  app: string;
  /** Custom app display name when set, else null. */
  displayName: string | null;
  /** Active foreground seconds for this app. */
  totalSeconds: number;
  /** Background seconds (away-listening / background video). */
  passiveSeconds: number;
  projects: ProjectTotal[];
}

export function getAppBreakdown(
  db: Database.Database,
  app: string,
  period: string,
  limit = 100,
  topSubProjects = 25,
): AppBreakdownResult {
  const range = parsePeriod(period);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?`;
  const params = [range.start, range.end, app];
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);
  const dn = displayNames.get(app) ?? null;

  const total = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${where}${active}`)
    .get(...params) as { seconds: number | null };

  const passiveTotal = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${where}${passive}`)
    .get(...params) as { seconds: number | null };

  const activeProjects = db
    .prepare(
      `SELECT e.app_name AS app, COALESCE(e.project, '') AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${active}
        GROUP BY e.project`
    )
    .all(...params) as Array<{ app: string; project: string; seconds: number }>;

  const passiveProjects = db
    .prepare(
      `SELECT e.app_name AS app, COALESCE(e.project, '') AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${passive}
        GROUP BY e.project`
    )
    .all(...params) as Array<{ app: string; project: string; seconds: number }>;

  const projMap = new Map<string, ProjectTotal>();
  // Key by (app, project) to match attachSubProjects' shared key shape.
  const pkey = (a: string, p: string) => `${a}\0${p}`;
  for (const r of activeProjects) {
    projMap.set(pkey(r.app, r.project), {
      app: r.app, displayName: dn, project: r.project,
      seconds: r.seconds, passiveSeconds: 0, subProjects: [],
    });
  }
  for (const r of passiveProjects) {
    const k = pkey(r.app, r.project);
    const existing = projMap.get(k);
    if (existing) existing.passiveSeconds = r.seconds;
    else projMap.set(k, {
      app: r.app, displayName: dn, project: r.project,
      seconds: 0, passiveSeconds: r.seconds, subProjects: [],
    });
  }

  attachSubProjects(db, projMap, where, params, topSubProjects);

  const projects = [...projMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
    .slice(0, limit);

  return {
    ...range,
    app,
    displayName: dn,
    totalSeconds: total.seconds ?? 0,
    passiveSeconds: passiveTotal.seconds ?? 0,
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
  const active = activeFilter(db);

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
    // Goals always count active foreground time only — matches the
    // dashboard's getGoalProgress (which uses ACTIVE_ONLY_NOALIAS).
    if (g.type === "overall") {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ?${iC}${active}`
        )
        .get(range.start, range.end, ...iP) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "tag" && g.tagId != null) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.tag_id = ?${active}`
        )
        .get(range.start, range.end, g.tagId) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "app" && g.app) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?${active}`
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
  /** Custom app display name when set, else null. */
  displayName: string | null;
  windowTitle: string | null;
  project: string | null;
  /** Third-tier breakdown — e.g. video title under YouTube. Null for native trackers. */
  subProject: string | null;
  /** True for away-listening entries (background music while idle). */
  isPassive: boolean;
  tagId: number | null;
  tagName: string | null;
}

export interface QueryEntriesArgs {
  period?: string;
  app?: string;
  project?: string;
  search?: string;
  /** "active" (default) | "passive" | "all". */
  mode?: "active" | "passive" | "all";
  limit?: number;
}

export function queryEntries(db: Database.Database, args: QueryEntriesArgs): EntryRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const hasPassive = hasPassiveColumn(db);

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
  // Default to active-only so the LLM gets foreground work by default;
  // callers asking for music history pass mode: "passive" or "all".
  const mode = args.mode ?? "active";
  if (hasPassive) {
    if (mode === "active") where.push("e.is_passive = 0");
    else if (mode === "passive") where.push("e.is_passive = 1");
  }

  const passiveSelect = hasPassive ? "e.is_passive AS isPassive" : "0 AS isPassive";
  const subProjectSelect = hasSubProjectColumn(db)
    ? "e.sub_project AS subProject"
    : "NULL AS subProject";
  const overridesJoin = hasAppOverridesTable(db)
    ? "LEFT JOIN app_overrides o ON o.app_name = e.app_name"
    : "";
  const displayNameSelect = hasAppOverridesTable(db)
    ? "o.display_name AS displayName"
    : "NULL AS displayName";

  const limit = Math.min(Math.max(args.limit ?? 200, 1), 5000);
  const sql = `
    SELECT e.id, e.timestamp, e.app_name AS app, ${displayNameSelect},
           e.window_title AS windowTitle, e.project, ${subProjectSelect},
           ${passiveSelect}, e.tag_id AS tagId, t.name AS tagName
      FROM entries e
      LEFT JOIN tags t ON t.id = e.tag_id
      ${overridesJoin}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY e.timestamp DESC
     LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as Array<
    Omit<EntryRow, "isPassive"> & { isPassive: number }
  >;
  return rows.map((r) => ({ ...r, isPassive: r.isPassive === 1 }));
}
