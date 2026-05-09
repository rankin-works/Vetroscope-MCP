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

/**
 * Optional hour-of-day / weekday filters layered on top of any base WHERE.
 * Hours are local time and form a half-open range: `hourStart <= h < hourEnd`
 * (so 9..17 means 9am through 4:59pm). Weekdays follow SQLite's `%w` —
 * 0=Sunday, 1=Monday, …, 6=Saturday.
 */
export interface TimeFilters {
  hourStart?: number;
  hourEnd?: number;
  weekdays?: number[];
}

/**
 * Resolves a user-supplied `device` string into a SQL filter on
 * `entries.device_id` / `entries.platform`. Accepts:
 *
 *   - undefined / "all"  → no filter
 *   - "current" / "this" → the local device's `sync_state.device_id`
 *   - a UUID-looking string → exact device_id match
 *   - any other string → case-insensitive platform match (e.g. "darwin",
 *     "win32", "browser-extension")
 *
 * Lets the LLM say `device: "darwin"` or `device: "current"` without
 * needing to look up the UUID first. Power users can still pass an
 * explicit UUID returned by get_device_breakdown for precision.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getCurrentDeviceId(db: Database.Database): string | null {
  try {
    const row = db.prepare(`SELECT value FROM sync_state WHERE key = 'device_id'`).get() as
      | { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function resolveDeviceFilter(
  db: Database.Database,
  device: string | undefined,
  alias = "e",
): { clause: string; params: string[] } {
  if (!device || device.toLowerCase() === "all") return { clause: "", params: [] };
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const hasDevice = cols.some((c) => c.name === "device_id");
  const hasPlatform = cols.some((c) => c.name === "platform");
  if (!hasDevice && !hasPlatform) return { clause: "", params: [] };

  const deviceCol = alias ? `${alias}.device_id` : "device_id";
  const platformCol = alias ? `${alias}.platform` : "platform";

  const lower = device.toLowerCase();
  if (lower === "current" || lower === "this") {
    const id = getCurrentDeviceId(db);
    if (!id) {
      // No sync_state — collapse to a never-true clause so the caller still
      // gets an empty result set (vs silently returning everything).
      return { clause: " AND 0 = 1", params: [] };
    }
    return hasDevice
      ? { clause: ` AND ${deviceCol} = ?`, params: [id] }
      : { clause: "", params: [] };
  }
  if (UUID_RE.test(device) && hasDevice) {
    return { clause: ` AND ${deviceCol} = ?`, params: [device] };
  }
  if (hasPlatform) {
    return { clause: ` AND LOWER(${platformCol}) = ?`, params: [lower] };
  }
  return { clause: "", params: [] };
}

function buildTimeFilters(filters: TimeFilters | undefined, alias = "e"): {
  clause: string;
  params: number[];
} {
  if (!filters) return { clause: "", params: [] };
  const col = alias ? `${alias}.timestamp` : "timestamp";
  const parts: string[] = [];
  const params: number[] = [];
  const { hourStart, hourEnd, weekdays } = filters;
  if (typeof hourStart === "number" && typeof hourEnd === "number"
      && !(hourStart === 0 && hourEnd === 24)) {
    parts.push(`CAST(strftime('%H', ${col}, 'localtime') AS INTEGER) >= ?`);
    parts.push(`CAST(strftime('%H', ${col}, 'localtime') AS INTEGER) < ?`);
    params.push(hourStart, hourEnd);
  }
  if (weekdays && weekdays.length > 0 && weekdays.length < 7) {
    const placeholders = weekdays.map(() => "?").join(",");
    parts.push(`CAST(strftime('%w', ${col}, 'localtime') AS INTEGER) IN (${placeholders})`);
    params.push(...weekdays);
  }
  if (parts.length === 0) return { clause: "", params: [] };
  return { clause: " AND " + parts.join(" AND "), params };
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
  opts: {
    topApps?: number;
    topProjects?: number;
    topSubProjects?: number;
    timeFilters?: TimeFilters;
    device?: string;
  } = {}
): ReportResult {
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const { clause: tC, params: tP } = buildTimeFilters(opts.timeFilters);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, opts.device);
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${iC}${tC}${dC}`;
  const baseParams = [range.start, range.end, ...iP, ...tP, ...dP];
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
  timeFilters?: TimeFilters,
  device?: string,
): AppBreakdownResult {
  const range = parsePeriod(period);
  const { clause: tC, params: tP } = buildTimeFilters(timeFilters);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, device);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?${tC}${dC}`;
  const params = [range.start, range.end, app, ...tP, ...dP];
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
  /** UUID of the device that recorded this entry. Null on pre-device-id DBs. */
  deviceId: string | null;
  /** "darwin" / "win32" / "browser-extension" etc. when known, else null. */
  platform: string | null;
}

export interface QueryEntriesArgs {
  period?: string;
  app?: string;
  project?: string;
  /** Restrict to entries carrying a tag with this exact name. */
  tag?: string;
  search?: string;
  /** "active" (default) | "passive" | "all". */
  mode?: "active" | "passive" | "all";
  /** Optional hour-of-day / weekday filter. */
  timeFilters?: TimeFilters;
  /** UUID, "current"/"this", platform name, or "all" / undefined for no filter. */
  device?: string;
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
  if (args.tag) {
    where.push("t.name = ?");
    params.push(args.tag);
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
  const { clause: tfC, params: tfP } = buildTimeFilters(args.timeFilters);
  if (tfC) {
    where.push(tfC.replace(/^ AND /, ""));
    params.push(...tfP);
  }
  const { clause: dfC, params: dfP } = resolveDeviceFilter(db, args.device);
  if (dfC) {
    where.push(dfC.replace(/^ AND /, ""));
    params.push(...dfP);
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
  const entryCols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const deviceIdSelect = entryCols.some((c) => c.name === "device_id")
    ? "e.device_id AS deviceId"
    : "NULL AS deviceId";
  const platformSelect = entryCols.some((c) => c.name === "platform")
    ? "e.platform AS platform"
    : "NULL AS platform";

  const limit = Math.min(Math.max(args.limit ?? 200, 1), 5000);
  const sql = `
    SELECT e.id, e.timestamp, e.app_name AS app, ${displayNameSelect},
           e.window_title AS windowTitle, e.project, ${subProjectSelect},
           ${passiveSelect}, e.tag_id AS tagId, t.name AS tagName,
           ${deviceIdSelect}, ${platformSelect}
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

// ── list_tags ─────────────────────────────────────────────────────────────

export interface TagInfo {
  id: number;
  name: string;
  color: string;
  /**
   * Sticky tags re-attach automatically to future entries matching the
   * (app, project) pairs they were applied to. Useful context for the LLM
   * when reasoning about why a tag shows up where it does.
   */
  sticky: boolean;
}

export function listTags(db: Database.Database): TagInfo[] {
  // `deleted` is the soft-delete flag used by Vetroscope's sync layer; we
  // never want to surface tombstoned tags. Older DBs may not have it.
  const cols = db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>;
  const hasDeleted = cols.some((c) => c.name === "deleted");
  const hasSticky = cols.some((c) => c.name === "sticky");
  const where = hasDeleted ? "WHERE deleted = 0" : "";
  const stickySelect = hasSticky ? "sticky" : "0 AS sticky";
  const rows = db
    .prepare(
      `SELECT id, name, color, ${stickySelect} FROM tags ${where} ORDER BY name COLLATE NOCASE`
    )
    .all() as Array<{ id: number; name: string; color: string; sticky: number }>;
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, sticky: r.sticky === 1 }));
}

// ── get_tag_breakdown ─────────────────────────────────────────────────────

export interface TagBreakdownResult extends Range {
  tag: TagInfo;
  /** Active foreground seconds carrying this tag. */
  totalSeconds: number;
  /** Background away-listening seconds carrying this tag. */
  passiveSeconds: number;
  /** Apps this tag appears under, sorted by total seconds desc. */
  apps: AppTotal[];
  /** Projects this tag appears under, sorted by total seconds desc. */
  projects: ProjectTotal[];
  /** Per-day series of active seconds for the tag across the period. */
  daily: Array<{ date: string; seconds: number }>;
}

/** Resolve a tag by name (case-insensitive) or numeric id. Returns null if absent. */
function resolveTag(db: Database.Database, identifier: string | number): TagInfo | null {
  const tags = listTags(db);
  if (typeof identifier === "number") {
    return tags.find((t) => t.id === identifier) ?? null;
  }
  const lower = identifier.toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === lower) ?? null;
}

export function getTagBreakdown(
  db: Database.Database,
  identifier: string | number,
  period: string,
  opts: { topApps?: number; topProjects?: number; timeFilters?: TimeFilters; device?: string } = {}
): TagBreakdownResult | null {
  const tag = resolveTag(db, identifier);
  if (!tag) return null;
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const { clause: tC, params: tP } = buildTimeFilters(opts.timeFilters);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, opts.device);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.tag_id = ?${iC}${tC}${dC}`;
  const params = [range.start, range.end, tag.id, ...iP, ...tP, ...dP];
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);
  const dn = (app: string) => displayNames.get(app) ?? null;

  const totalActive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${where}${active}`)
    .get(...params) as { seconds: number | null };
  const totalPassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${where}${passive}`)
    .get(...params) as { seconds: number | null };

  const activeApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${active}
        GROUP BY e.app_name`
    )
    .all(...params) as Array<{ app: string; seconds: number }>;
  const passiveApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${passive}
        GROUP BY e.app_name`
    )
    .all(...params) as Array<{ app: string; seconds: number }>;

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

  const activeProjects = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${active} AND e.project IS NOT NULL AND e.project != ''
        GROUP BY e.app_name, e.project`
    )
    .all(...params) as Array<{ app: string; project: string; seconds: number }>;
  const passiveProjects = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${passive} AND e.project IS NOT NULL AND e.project != ''
        GROUP BY e.app_name, e.project`
    )
    .all(...params) as Array<{ app: string; project: string; seconds: number }>;

  const projMap = new Map<string, ProjectTotal>();
  const pkey = (a: string, p: string) => `${a}\0${p}`;
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
  attachSubProjects(db, projMap, where, params, 25);
  const projects = [...projMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
    .slice(0, opts.topProjects ?? 50);

  // Per-day active series — useful for trend questions ("am I doing more
  // Vetroscope Dev this week than last?").
  const dailyRows = db
    .prepare(
      `SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${active}
        GROUP BY DATE(e.timestamp, 'localtime')
        ORDER BY date`
    )
    .all(...params) as Array<{ date: string; seconds: number }>;

  return {
    ...range,
    tag,
    totalSeconds: totalActive.seconds ?? 0,
    passiveSeconds: totalPassive.seconds ?? 0,
    apps,
    projects,
    daily: dailyRows,
  };
}

// ── get_app_stats ─────────────────────────────────────────────────────────

export interface AppStatsResult {
  app: string;
  displayName: string | null;
  /**
   * Lifetime totals (active foreground seconds across the entire DB).
   * Use `period` for a windowed view via daily / hourOfDay / weekday.
   */
  lifetime: {
    totalSeconds: number;
    passiveSeconds: number;
    daysActive: number;
    firstSeen: string | null;
    lastSeen: string | null;
    avgSecondsPerActiveDay: number;
  };
  /** Period totals (matches the period argument). */
  period: Range & {
    totalSeconds: number;
    passiveSeconds: number;
  };
  /** Top projects within the period with active/passive split. */
  topProjects: ProjectTotal[];
  /** Daily active seconds within the period. */
  daily: Array<{ date: string; seconds: number }>;
  /** 24-hour distribution of active seconds within the period. */
  hourOfDay: Array<{ hour: number; seconds: number }>;
  /** Day-of-week distribution within the period. 0=Sunday. */
  weekday: Array<{ weekday: number; seconds: number }>;
}

export function getAppStats(
  db: Database.Database,
  app: string,
  period = "week",
  device?: string,
): AppStatsResult | null {
  const range = parsePeriod(period);
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);
  const dn = displayNames.get(app) ?? null;
  const { clause: dC, params: dP } = resolveDeviceFilter(db, device);

  // Lifetime stats — no period filter, just app filter.
  const lifetimeRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstSeen,
              MAX(e.timestamp) AS lastSeen,
              COUNT(DISTINCT DATE(e.timestamp, 'localtime')) AS daysActive
         FROM entries e
        WHERE e.app_name = ?${dC}${active}`
    )
    .get(app, ...dP) as { seconds: number | null; firstSeen: string | null; lastSeen: string | null; daysActive: number };
  if (!lifetimeRow.seconds) return null;
  const lifetimePassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE e.app_name = ?${dC}${passive}`)
    .get(app, ...dP) as { seconds: number | null };

  const periodWhere = `e.app_name = ? AND e.timestamp >= ? AND e.timestamp < ?${dC}`;
  const periodParams = [app, range.start, range.end, ...dP];

  const periodActive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active}`)
    .get(...periodParams) as { seconds: number | null };
  const periodPassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${passive}`)
    .get(...periodParams) as { seconds: number | null };

  // Top projects within the period — same active/passive split as the
  // app_breakdown tool but flat (no sub-projects nested) since stats is a
  // higher-level overview.
  const projActive = db
    .prepare(
      `SELECT e.app_name AS app, COALESCE(e.project, '') AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${periodWhere}${active}
        GROUP BY e.project`
    )
    .all(...periodParams) as Array<{ app: string; project: string; seconds: number }>;
  const projPassive = db
    .prepare(
      `SELECT e.app_name AS app, COALESCE(e.project, '') AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${periodWhere}${passive}
        GROUP BY e.project`
    )
    .all(...periodParams) as Array<{ app: string; project: string; seconds: number }>;
  const projMap = new Map<string, ProjectTotal>();
  for (const r of projActive) {
    projMap.set(r.project, {
      app: r.app, displayName: dn, project: r.project,
      seconds: r.seconds, passiveSeconds: 0, subProjects: [],
    });
  }
  for (const r of projPassive) {
    const existing = projMap.get(r.project);
    if (existing) existing.passiveSeconds = r.seconds;
    else projMap.set(r.project, {
      app: r.app, displayName: dn, project: r.project,
      seconds: 0, passiveSeconds: r.seconds, subProjects: [],
    });
  }
  const topProjects = [...projMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds))
    .slice(0, 25);

  const daily = db
    .prepare(
      `SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${periodWhere}${active}
        GROUP BY DATE(e.timestamp, 'localtime')
        ORDER BY date`
    )
    .all(...periodParams) as Array<{ date: string; seconds: number }>;

  // Densify hour-of-day to all 24 hours so callers don't have to sparse-fill.
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', e.timestamp, 'localtime') AS INTEGER) AS hour,
              ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${periodWhere}${active}
        GROUP BY hour
        ORDER BY hour`
    )
    .all(...periodParams) as Array<{ hour: number; seconds: number }>;
  const hourMap = new Map<number, number>(hourRows.map((r) => [r.hour, r.seconds]));
  const hourOfDay = Array.from({ length: 24 }, (_, h) => ({
    hour: h, seconds: hourMap.get(h) ?? 0,
  }));

  const weekdayRows = db
    .prepare(
      `SELECT CAST(strftime('%w', e.timestamp, 'localtime') AS INTEGER) AS weekday,
              ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${periodWhere}${active}
        GROUP BY weekday
        ORDER BY weekday`
    )
    .all(...periodParams) as Array<{ weekday: number; seconds: number }>;
  const wdMap = new Map<number, number>(weekdayRows.map((r) => [r.weekday, r.seconds]));
  const weekday = Array.from({ length: 7 }, (_, w) => ({
    weekday: w, seconds: wdMap.get(w) ?? 0,
  }));

  const totalSeconds = lifetimeRow.seconds;
  const avgSecondsPerActiveDay = lifetimeRow.daysActive > 0
    ? Math.round(totalSeconds / lifetimeRow.daysActive)
    : 0;

  return {
    app,
    displayName: dn,
    lifetime: {
      totalSeconds,
      passiveSeconds: lifetimePassive.seconds ?? 0,
      daysActive: lifetimeRow.daysActive,
      firstSeen: lifetimeRow.firstSeen,
      lastSeen: lifetimeRow.lastSeen,
      avgSecondsPerActiveDay,
    },
    period: {
      ...range,
      totalSeconds: periodActive.seconds ?? 0,
      passiveSeconds: periodPassive.seconds ?? 0,
    },
    topProjects,
    daily,
    hourOfDay,
    weekday,
  };
}

// ── list_markers ──────────────────────────────────────────────────────────

export interface Marker {
  id: number;
  timestamp: string;
  /** Present when this marker is a region (start + end). Null for point markers. */
  endTimestamp: string | null;
  label: string;
  color: string;
  icon: string;
}

/**
 * User-placed timeline events. Vetroscope soft-deletes markers (deleted=1)
 * for sync purposes; we only return live ones. Period filter is optional —
 * omit to return every marker in the DB.
 */
export function listMarkers(db: Database.Database, period?: string): Marker[] {
  const cols = db.prepare(`PRAGMA table_info(markers)`).all() as Array<{ name: string }>;
  const hasDeleted = cols.some((c) => c.name === "deleted");
  const hasEnd = cols.some((c) => c.name === "end_timestamp");
  const endSelect = hasEnd ? "end_timestamp AS endTimestamp" : "NULL AS endTimestamp";
  const baseFilter = hasDeleted ? "deleted = 0" : "1 = 1";
  const where: string[] = [baseFilter];
  const params: (string | number)[] = [];
  if (period) {
    const range = parsePeriod(period);
    // Include any marker whose region OVERLAPS the period: start before end-of-period
    // AND (no end OR end after start-of-period).
    where.push("timestamp < ?");
    params.push(range.end);
    if (hasEnd) {
      where.push("(end_timestamp IS NULL OR end_timestamp >= ?)");
      params.push(range.start);
    } else {
      where.push("timestamp >= ?");
      params.push(range.start);
    }
  }
  const rows = db
    .prepare(
      `SELECT id, timestamp, ${endSelect}, label, color, icon
         FROM markers
        WHERE ${where.join(" AND ")}
        ORDER BY timestamp DESC`
    )
    .all(...params) as Marker[];
  return rows;
}

// ── get_sessions ──────────────────────────────────────────────────────────

export interface Session {
  app: string;
  displayName: string | null;
  project: string | null;
  subProject: string | null;
  tagName: string | null;
  startTime: string;
  endTime: string;
  totalSeconds: number;
  isPassive: boolean;
}

/**
 * Continuous activity blocks reconstructed from the 30s poll entries.
 * Two consecutive entries belong to the same session when (a) they share
 * the same (app, project) pair and (b) their timestamps are within 90s
 * of each other — three poll intervals tolerates one missed poll without
 * breaking the session. This is the same heuristic Vetroscope uses for
 * the Activity view in the desktop app.
 */
export function getSessions(
  db: Database.Database,
  period: string,
  opts: {
    app?: string;
    project?: string;
    tag?: string;
    minSeconds?: number;
    limit?: number;
    timeFilters?: TimeFilters;
    device?: string;
  } = {}
): Session[] {
  const range = parsePeriod(period);
  const { clause: tC, params: tP } = buildTimeFilters(opts.timeFilters);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, opts.device);
  const where: string[] = ["e.timestamp >= ?", "e.timestamp < ?"];
  const params: (string | number)[] = [range.start, range.end];
  if (opts.app) { where.push("e.app_name = ?"); params.push(opts.app); }
  if (opts.project) { where.push("e.project = ?"); params.push(opts.project); }
  if (opts.tag) { where.push("t.name = ?"); params.push(opts.tag); }
  if (tC) { where.push(tC.replace(/^ AND /, "")); params.push(...tP); }
  if (dC) { where.push(dC.replace(/^ AND /, "")); params.push(...dP); }

  const hasPassive = hasPassiveColumn(db);
  const hasSubProj = hasSubProjectColumn(db);
  const passiveSelect = hasPassive ? "e.is_passive AS isPassive" : "0 AS isPassive";
  const subProjectSelect = hasSubProj ? "e.sub_project AS subProject" : "NULL AS subProject";
  const overridesJoin = hasAppOverridesTable(db)
    ? "LEFT JOIN app_overrides o ON o.app_name = e.app_name"
    : "";
  const displayNameSelect = hasAppOverridesTable(db)
    ? "o.display_name AS displayName"
    : "NULL AS displayName";

  const rows = db
    .prepare(
      `SELECT e.timestamp, e.app_name AS app, ${displayNameSelect},
              e.project, ${subProjectSelect}, t.name AS tagName, ${passiveSelect}
         FROM entries e
         LEFT JOIN tags t ON t.id = e.tag_id
         ${overridesJoin}
        WHERE ${where.join(" AND ")}
        ORDER BY e.timestamp ASC`
    )
    .all(...params) as Array<{
    timestamp: string;
    app: string;
    displayName: string | null;
    project: string | null;
    subProject: string | null;
    tagName: string | null;
    isPassive: number;
  }>;

  const SESSION_GAP_MS = 90_000;
  const sessions: Session[] = [];
  let cur: (Session & { _last: number }) | null = null;
  for (const r of rows) {
    const ts = Date.parse(r.timestamp);
    const matches =
      cur != null &&
      cur.app === r.app &&
      cur.project === r.project &&
      cur.subProject === r.subProject &&
      cur.isPassive === (r.isPassive === 1) &&
      ts - cur._last <= SESSION_GAP_MS;
    if (matches && cur) {
      cur.endTime = r.timestamp;
      cur.totalSeconds += POLL_SECONDS;
      cur._last = ts;
    } else {
      if (cur) {
        const { _last, ...session } = cur;
        sessions.push(session);
      }
      cur = {
        app: r.app,
        displayName: r.displayName,
        project: r.project,
        subProject: r.subProject,
        tagName: r.tagName,
        startTime: r.timestamp,
        endTime: r.timestamp,
        totalSeconds: POLL_SECONDS,
        isPassive: r.isPassive === 1,
        _last: ts,
      };
    }
  }
  if (cur) {
    const { _last, ...session } = cur;
    sessions.push(session);
  }

  const minSec = opts.minSeconds ?? 0;
  const filtered = minSec > 0 ? sessions.filter((s) => s.totalSeconds >= minSec) : sessions;
  // Newest first matches Activity view ordering.
  filtered.sort((a, b) => b.endTime.localeCompare(a.endTime));
  return filtered.slice(0, Math.min(Math.max(opts.limit ?? 200, 1), 5000));
}

// ── get_current_status ────────────────────────────────────────────────────

export interface CurrentStatus {
  /** ISO timestamp of the latest entry (null when DB is empty). */
  timestamp: string | null;
  /** Seconds elapsed since that entry was recorded. */
  secondsSince: number | null;
  /**
   * "tracking" when the latest entry is within ~90s, otherwise "idle".
   * Idle simply means the tracker hasn't recorded anything recently —
   * Vetroscope itself may be paused, or you may not be at the device.
   */
  state: "tracking" | "idle" | "unknown";
  app: string | null;
  displayName: string | null;
  project: string | null;
  subProject: string | null;
  tagName: string | null;
  isPassive: boolean | null;
}

export function getCurrentStatus(db: Database.Database): CurrentStatus {
  const hasPassive = hasPassiveColumn(db);
  const hasSubProj = hasSubProjectColumn(db);
  const overridesJoin = hasAppOverridesTable(db)
    ? "LEFT JOIN app_overrides o ON o.app_name = e.app_name"
    : "";
  const displayNameSelect = hasAppOverridesTable(db)
    ? "o.display_name AS displayName"
    : "NULL AS displayName";
  const passiveSelect = hasPassive ? "e.is_passive AS isPassive" : "0 AS isPassive";
  const subProjectSelect = hasSubProj ? "e.sub_project AS subProject" : "NULL AS subProject";

  const row = db
    .prepare(
      `SELECT e.timestamp, e.app_name AS app, ${displayNameSelect},
              e.project, ${subProjectSelect}, t.name AS tagName, ${passiveSelect}
         FROM entries e
         LEFT JOIN tags t ON t.id = e.tag_id
         ${overridesJoin}
        ORDER BY e.timestamp DESC
        LIMIT 1`
    )
    .get() as
    | {
        timestamp: string;
        app: string;
        displayName: string | null;
        project: string | null;
        subProject: string | null;
        tagName: string | null;
        isPassive: number;
      }
    | undefined;

  if (!row) {
    return {
      timestamp: null, secondsSince: null, state: "unknown",
      app: null, displayName: null, project: null, subProject: null, tagName: null, isPassive: null,
    };
  }
  const ageMs = Date.now() - Date.parse(row.timestamp);
  const secondsSince = Math.max(0, Math.round(ageMs / 1000));
  // 90s = three poll intervals; if we haven't seen a tick in that window the
  // tracker is effectively asleep from the LLM's perspective.
  const state = secondsSince <= 90 ? "tracking" : "idle";
  return {
    timestamp: row.timestamp,
    secondsSince,
    state,
    app: row.app,
    displayName: row.displayName,
    project: row.project,
    subProject: row.subProject,
    tagName: row.tagName,
    isPassive: row.isPassive === 1,
  };
}

// ── get_goal_achievements ─────────────────────────────────────────────────

export interface GoalAchievement {
  id: number;
  goalId: number | null;
  /** Goal at the time of achievement (snapshot — survives later edits). */
  type: "app" | "overall" | "tag";
  app: string | null;
  tagName: string | null;
  targetSeconds: number;
  currentSeconds: number;
  /** Local YYYY-MM-DD on which the goal was hit. */
  date: string;
  /** ISO timestamp when the achievement was first recorded. */
  achievedAt: string;
}

interface GoalSnapshot {
  type?: string;
  app_name?: string | null;
  tag_name?: string | null;
  target_seconds?: number;
}

export function getGoalAchievements(
  db: Database.Database,
  period = "month"
): GoalAchievement[] {
  const range = parsePeriod(period);
  // `date` is a local YYYY-MM-DD string, not an ISO timestamp, so we filter
  // on the YYYY-MM-DD prefix of the period's start/end instead of the full
  // ISO bounds.
  const startDate = range.start.slice(0, 10);
  const endDate = range.end.slice(0, 10);
  const cols = db.prepare(`PRAGMA table_info(goal_achievements)`).all() as Array<{ name: string }>;
  const hasDeleted = cols.some((c) => c.name === "deleted");
  const where = hasDeleted
    ? "date >= ? AND date < ? AND deleted = 0"
    : "date >= ? AND date < ?";
  const rows = db
    .prepare(
      `SELECT id, goal_id AS goalId, goal_snapshot AS goalSnapshot,
              date, achieved_at AS achievedAt, current_seconds AS currentSeconds
         FROM goal_achievements
        WHERE ${where}
        ORDER BY date DESC, achieved_at DESC`
    )
    .all(startDate, endDate) as Array<{
    id: number;
    goalId: number | null;
    goalSnapshot: string;
    date: string;
    achievedAt: string;
    currentSeconds: number;
  }>;
  return rows.map((r): GoalAchievement => {
    let snap: GoalSnapshot = {};
    try { snap = JSON.parse(r.goalSnapshot) as GoalSnapshot; } catch { /* keep empty */ }
    const type = (snap.type === "app" || snap.type === "overall" || snap.type === "tag")
      ? snap.type : "app";
    return {
      id: r.id,
      goalId: r.goalId,
      type,
      app: snap.app_name ?? null,
      tagName: snap.tag_name ?? null,
      targetSeconds: snap.target_seconds ?? 0,
      currentSeconds: r.currentSeconds,
      date: r.date,
      achievedAt: r.achievedAt,
    };
  });
}

// ── list_projects ─────────────────────────────────────────────────────────

export interface ProjectListEntry {
  app: string;
  displayName: string | null;
  project: string;
  totalSeconds: number;
  passiveSeconds: number;
  daysActive: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Every project ever recorded, with all-time totals and first/last seen.
 * Optional substring search (case-insensitive) makes fuzzy lookups easy.
 */
export function listProjects(
  db: Database.Database,
  opts: { search?: string; limit?: number } = {}
): ProjectListEntry[] {
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const where: string[] = ["e.project IS NOT NULL", "e.project != ''"];
  const params: (string | number)[] = [];
  if (opts.search) {
    where.push("(LOWER(e.project) LIKE ? OR LOWER(e.app_name) LIKE ?)");
    const term = `%${opts.search.toLowerCase()}%`;
    params.push(term, term);
  }
  const baseWhere = where.join(" AND ");

  const activeRows = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project,
              ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstSeen,
              MAX(e.timestamp) AS lastSeen,
              COUNT(DISTINCT DATE(e.timestamp, 'localtime')) AS daysActive
         FROM entries e
        WHERE ${baseWhere}${active}
        GROUP BY e.app_name, e.project`
    )
    .all(...params) as Array<{
    app: string; project: string; seconds: number;
    firstSeen: string; lastSeen: string; daysActive: number;
  }>;
  const passiveRows = db
    .prepare(
      `SELECT e.app_name AS app, e.project AS project, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${passive}
        GROUP BY e.app_name, e.project`
    )
    .all(...params) as Array<{ app: string; project: string; seconds: number }>;

  const displayNames = loadDisplayNames(db);
  const map = new Map<string, ProjectListEntry>();
  const k = (a: string, p: string) => `${a}\0${p}`;
  for (const r of activeRows) {
    map.set(k(r.app, r.project), {
      app: r.app, displayName: displayNames.get(r.app) ?? null,
      project: r.project, totalSeconds: r.seconds, passiveSeconds: 0,
      daysActive: r.daysActive, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
    });
  }
  for (const r of passiveRows) {
    const existing = map.get(k(r.app, r.project));
    if (existing) existing.passiveSeconds = r.seconds;
    // Skip passive-only projects from activeRows-derived metadata: they'd
    // have no firstSeen/daysActive so they're not as useful to surface here.
  }
  const out = [...map.values()].sort((a, b) =>
    (b.totalSeconds + b.passiveSeconds) - (a.totalSeconds + a.passiveSeconds));
  return out.slice(0, Math.min(Math.max(opts.limit ?? 200, 1), 5000));
}

// ── get_calendar ──────────────────────────────────────────────────────────

export interface CalendarDay {
  date: string;
  seconds: number;
  passiveSeconds: number;
}

export interface CalendarResult extends Range {
  totalSeconds: number;
  totalPassiveSeconds: number;
  /** Dense per-day series including zero-second days for streak math. */
  days: CalendarDay[];
}

/**
 * GitHub-contribution-grid-style daily totals. Default period is `year` for
 * the full annual heatmap; pass any other period for narrower windows.
 * Days with zero activity are explicitly included so streak / gap analysis
 * doesn't have to inflate the result.
 */
export function getCalendar(db: Database.Database, period = "year", device?: string): CalendarResult {
  const range = parsePeriod(period);
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, device);
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${iC}${dC}`;
  const baseParams = [range.start, range.end, ...iP, ...dP];

  const activeRows = db
    .prepare(
      `SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${active}
        GROUP BY DATE(e.timestamp, 'localtime')`
    )
    .all(...baseParams) as Array<{ date: string; seconds: number }>;
  const passiveRows = db
    .prepare(
      `SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere}${passive}
        GROUP BY DATE(e.timestamp, 'localtime')`
    )
    .all(...baseParams) as Array<{ date: string; seconds: number }>;

  const activeMap = new Map(activeRows.map((r) => [r.date, r.seconds]));
  const passiveMap = new Map(passiveRows.map((r) => [r.date, r.seconds]));

  // Densify: walk the local-date range from start..end (exclusive end).
  const days: CalendarDay[] = [];
  const startLocal = new Date(range.start);
  const endLocal = new Date(range.end);
  const cursor = new Date(startLocal.getFullYear(), startLocal.getMonth(), startLocal.getDate());
  let totalActive = 0;
  let totalPassive = 0;
  while (cursor < endLocal) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    const a = activeMap.get(key) ?? 0;
    const p = passiveMap.get(key) ?? 0;
    days.push({ date: key, seconds: a, passiveSeconds: p });
    totalActive += a;
    totalPassive += p;
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    ...range,
    totalSeconds: totalActive,
    totalPassiveSeconds: totalPassive,
    days,
  };
}

// ── get_device_breakdown ──────────────────────────────────────────────────

export interface DeviceTotal {
  deviceId: string;
  isCurrent: boolean;
  /** Most-frequent platform string seen on this device (e.g. "macos", "windows"). */
  platform: string | null;
  totalSeconds: number;
  passiveSeconds: number;
  daysActive: number;
  firstSeen: string;
  lastSeen: string;
}

export interface DeviceBreakdownResult extends Range {
  totalSeconds: number;
  devices: DeviceTotal[];
}

export function getDeviceBreakdown(
  db: Database.Database,
  period = "month",
): DeviceBreakdownResult {
  const range = parsePeriod(period);
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const hasDevice = cols.some((c) => c.name === "device_id");
  const hasPlatform = cols.some((c) => c.name === "platform");
  if (!hasDevice) {
    // Single-device DBs that pre-date the device_id migration have nothing
    // meaningful to break out — return a synthetic "this device" total.
    const total = db
      .prepare(
        `SELECT ${SECONDS_EXPR} AS seconds FROM entries e
           WHERE e.timestamp >= ? AND e.timestamp < ?${activeFilter(db)}`
      )
      .get(range.start, range.end) as { seconds: number | null };
    return { ...range, totalSeconds: total.seconds ?? 0, devices: [] };
  }
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.device_id IS NOT NULL`;
  const params = [range.start, range.end];

  const activeRows = db
    .prepare(
      `SELECT e.device_id AS deviceId, ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstSeen, MAX(e.timestamp) AS lastSeen,
              COUNT(DISTINCT DATE(e.timestamp, 'localtime')) AS daysActive
         FROM entries e
        WHERE ${where}${active}
        GROUP BY e.device_id`
    )
    .all(...params) as Array<{
    deviceId: string; seconds: number;
    firstSeen: string; lastSeen: string; daysActive: number;
  }>;
  const passiveRows = db
    .prepare(
      `SELECT e.device_id AS deviceId, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${where}${passive}
        GROUP BY e.device_id`
    )
    .all(...params) as Array<{ deviceId: string; seconds: number }>;

  // Most-frequent platform per device gives the LLM something to label
  // each device with — "macos" / "windows" / "browser-extension".
  const platformByDevice = new Map<string, string>();
  if (hasPlatform) {
    const platRows = db
      .prepare(
        `SELECT e.device_id AS deviceId, e.platform, COUNT(*) AS cnt
           FROM entries e
          WHERE ${where} AND e.platform IS NOT NULL
          GROUP BY e.device_id, e.platform`
      )
      .all(...params) as Array<{ deviceId: string; platform: string; cnt: number }>;
    const winners = new Map<string, number>();
    for (const r of platRows) {
      const cur = winners.get(r.deviceId) ?? -1;
      if (r.cnt > cur) {
        winners.set(r.deviceId, r.cnt);
        platformByDevice.set(r.deviceId, r.platform);
      }
    }
  }

  // Identify the local device id from sync_state so the LLM can mark it.
  let currentDeviceId: string | null = null;
  try {
    const row = db
      .prepare(`SELECT value FROM sync_state WHERE key = 'device_id'`)
      .get() as { value: string } | undefined;
    currentDeviceId = row?.value ?? null;
  } catch { /* sync_state may not exist on very old DBs */ }

  const passiveMap = new Map(passiveRows.map((r) => [r.deviceId, r.seconds]));
  const devices: DeviceTotal[] = activeRows.map((r) => ({
    deviceId: r.deviceId,
    isCurrent: r.deviceId === currentDeviceId,
    platform: platformByDevice.get(r.deviceId) ?? null,
    totalSeconds: r.seconds,
    passiveSeconds: passiveMap.get(r.deviceId) ?? 0,
    daysActive: r.daysActive,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
  }));
  devices.sort((a, b) => b.totalSeconds - a.totalSeconds);

  const totalSeconds = devices.reduce((acc, d) => acc + d.totalSeconds, 0);
  return { ...range, totalSeconds, devices };
}
