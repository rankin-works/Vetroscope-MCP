import type Database from "better-sqlite3";
import { parsePeriod, type Range } from "./periods.js";
import { categorizeApp, CATEGORY_LABELS, type AppCategory } from "./categories.js";

/**
 * Vetroscope polls every 30s. The dashboard computes durations as the count
 * of distinct 30s buckets that contain at least one foreground entry — this
 * matches the desktop app's reported totals. Source of truth lives in
 * `electron/database.ts` (POLL_INTERVAL_SECONDS).
 *
 * Period aggregations (`get_report` and siblings) honor the **same SQLite
 * filter stack** as the desktop report: ignored apps, ignored projects +
 * breakdown patterns, the `days_filter` setting (`weekdays` / `weekends` /
 * `all`), distinct-bucket rounding, passive-row rules, optional device /
 * MCP hour/weekday filters layered on top.
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

// media_links table arrived in Vetroscope 0.2.30 — users on older
// installs won't have it. Feature-detect once per DB handle so the
// MCP keeps working against any version (the tools just return null
// urls / empty results when the table is missing).
let _hasMediaLinksTable: WeakMap<Database.Database, boolean> = new WeakMap();
function hasMediaLinksTable(db: Database.Database): boolean {
  const cached = _hasMediaLinksTable.get(db);
  if (cached !== undefined) return cached;
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='media_links'`)
    .all() as Array<{ name: string }>;
  const has = rows.length > 0;
  _hasMediaLinksTable.set(db, has);
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

/** Exact (app, project) pairs the user excludes from reports — see `ignored_projects` in Vetroscope settings. */
interface IgnoredProjectRow {
  appName: string;
  project: string;
}

/** Per-app substring/extension patterns excluded from breakdowns — `ignored_breakdown_patterns`. */
interface IgnoredBreakdownPatternRow {
  appName: string;
  pattern: string;
}

function getIgnoredProjects(db: Database.Database): IgnoredProjectRow[] {
  const v = readJsonSetting<unknown>(db, "ignored_projects", []);
  if (!Array.isArray(v)) return [];
  const out: IgnoredProjectRow[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.appName === "string" && typeof o.project === "string") {
      out.push({ appName: o.appName, project: o.project });
    }
  }
  return out;
}

function getIgnoredBreakdownPatterns(db: Database.Database): IgnoredBreakdownPatternRow[] {
  const v = readJsonSetting<unknown>(db, "ignored_breakdown_patterns", []);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (p): p is IgnoredBreakdownPatternRow =>
      !!p
      && typeof p === "object"
      && typeof (p as IgnoredBreakdownPatternRow).appName === "string"
      && typeof (p as IgnoredBreakdownPatternRow).pattern === "string"
      && (p as IgnoredBreakdownPatternRow).pattern.length > 0,
  );
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function patternToLike(raw: string): string {
  const trimmed = raw.trim();
  const escaped = escapeLike(trimmed.toLowerCase());
  if (trimmed.startsWith(".")) return `%${escaped}`;
  return `%${escaped}%`;
}

/**
 * Same logic as `buildIgnoredProjectsFilter` in the desktop app: drop ignored
 * project tuples and pattern-matched breakdown rows from report totals.
 */
function buildIgnoredProjectsClause(
  db: Database.Database,
  alias = "e",
): { clause: string; params: string[] } {
  const ignoredProjects = getIgnoredProjects(db);
  const patterns = getIgnoredBreakdownPatterns(db);
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const params: string[] = [];
  for (const p of ignoredProjects) {
    clauses.push(`NOT (${prefix}app_name = ? AND ${prefix}project = ?)`);
    params.push(p.appName, p.project);
  }
  for (const p of patterns) {
    clauses.push(
      `NOT (${prefix}app_name = ? AND ${prefix}project IS NOT NULL AND LOWER(${prefix}project) LIKE ? ESCAPE '\\')`,
    );
    params.push(p.appName, patternToLike(p.pattern));
  }
  if (clauses.length === 0) return { clause: "", params: [] };
  return { clause: ` AND ${clauses.join(" AND ")}`, params };
}

function getSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Mirrors `buildDaysFilter` in `electron/database.ts` (`days_filter` setting). */
function dashboardDaysClause(db: Database.Database, alias = "e"): string {
  const pref = getSetting(db, "days_filter") || "all";
  const col = alias ? `${alias}.timestamp` : "timestamp";
  if (pref === "weekdays") {
    return ` AND CAST(strftime('%w', ${col}, 'localtime') AS INTEGER) BETWEEN 1 AND 5`;
  }
  if (pref === "weekends") {
    return ` AND CAST(strftime('%w', ${col}, 'localtime') AS INTEGER) IN (0, 6)`;
  }
  return "";
}

/**
 * Everything the desktop dashboard layers on top of the date range before
 * bucket-aggregating: ignored apps, ignored projects / patterns, device,
 * `days_filter`, and optional MCP hour/weekday filters. Order and params
 * match `electron/database.ts` report queries.
 */
function dashboardEntryClauseAndParams(
  db: Database.Database,
  alias = "e",
  opts: { timeFilters?: TimeFilters; device?: string } = {},
): { clause: string; params: (string | number)[] } {
  const ignored = getIgnoredApps(db);
  const { clause: iC, params: iP } = ignoredAppsClause(ignored, alias);
  const { clause: projC, params: projP } = buildIgnoredProjectsClause(db, alias);
  const { clause: dC, params: dP } = resolveDeviceFilter(db, opts.device, alias);
  const daysC = dashboardDaysClause(db, alias);
  const { clause: tC, params: tP } = buildTimeFilters(opts.timeFilters, alias);
  return {
    clause: `${iC}${projC}${dC}${daysC}${tC}`,
    params: [...iP, ...projP, ...dP, ...tP],
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
  /**
   * Canonical deep-link captured by Vetroscope ≥ 0.2.30 when the user
   * opted into `capture_media_links`. `https://www.youtube.com/watch?v=…`
   * for YouTube watch pages; null when the user hasn't enabled capture,
   * the sub-project is from a non-supported source, or the install
   * predates the feature.
   */
  url: string | null;
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
  /**
   * Active foreground seconds across all apps — matches the dashboard headline
   * when nothing is filtered differently in the MCP (same knobs as desktop:
   * ignored apps/projects/patterns, `days_filter`, device, optional hour/weekday tools).
   */
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
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const baseParams = [range.start, range.end, ...dash.params];
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
 * `whereClause` and `whereParams` describe the dashboard filter stack + date
 * range — same shape used by the parent project query so totals line up.
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
      url: null,
    });
  }
  for (const r of passiveSubs) {
    const inner = ensure(r.app, r.project);
    const existing = inner.get(r.subProject);
    if (existing) existing.passiveSeconds = r.seconds;
    else inner.set(r.subProject, { subProject: r.subProject, seconds: 0, passiveSeconds: r.seconds, url: null });
  }

  // Hydrate the canonical deep-link from media_links when the user
  // has captured any. One bulk SELECT scoped to the (app, project)
  // pairs we care about; per-row Map lookup keeps the hot loop O(1).
  // Skipped entirely when the table doesn't exist on this install.
  if (hasMediaLinksTable(db) && subMap.size > 0) {
    const appProjPairs = [...subMap.keys()].map((k) => k.split("\0")) as Array<[string, string]>;
    const orClauses = appProjPairs.map(() => "(app_name = ? AND project = ?)").join(" OR ");
    const linkParams = appProjPairs.flat();
    const linkRows = db
      .prepare(
        `SELECT app_name AS app, project, sub_project AS subProject, url
           FROM media_links
          WHERE ${orClauses}`
      )
      .all(...linkParams) as Array<{ app: string; project: string; subProject: string; url: string }>;
    for (const r of linkRows) {
      const inner = subMap.get(pkey(r.app, r.project));
      if (!inner) continue;
      const target = inner.get(r.subProject);
      if (target) target.url = r.url;
    }
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
  const dash = dashboardEntryClauseAndParams(db, "e", { timeFilters, device });
  const where = `e.timestamp >= ? AND e.timestamp < ?${dash.clause} AND e.app_name = ?`;
  const params = [range.start, range.end, ...dash.params, app];
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
  const dash = dashboardEntryClauseAndParams(db, "e", {});
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
            WHERE e.timestamp >= ? AND e.timestamp < ?${dash.clause}${active}`
        )
        .get(range.start, range.end, ...dash.params) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "tag" && g.tagId != null) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.tag_id = ?${dash.clause}${active}`
        )
        .get(range.start, range.end, g.tagId, ...dash.params) as { seconds: number | null };
      current = row.seconds ?? 0;
    } else if (g.type === "app" && g.app) {
      const row = db
        .prepare(
          `SELECT ${SECONDS_EXPR} AS seconds
             FROM entries e
            WHERE e.timestamp >= ? AND e.timestamp < ? AND e.app_name = ?${dash.clause}${active}`
        )
        .get(range.start, range.end, g.app, ...dash.params) as { seconds: number | null };
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
    const dash = dashboardEntryClauseAndParams(db, "e", {
      timeFilters: args.timeFilters,
      device: args.device,
    });
    if (dash.clause) {
      where.push(dash.clause.replace(/^ AND /, ""));
      params.push(...dash.params);
    }
  }
  else {
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
  /** True when the tag is archived. Archived tags are hidden from list_tags
   *  by default (matching the app), so this is only ever true when the
   *  caller explicitly opts in via includeArchived. */
  archived: boolean;
  /** Immediate parent tag id when this tag is nested, else null. Vetroscope
   *  supports a tag hierarchy (parent_id) the LLM should be aware of. */
  parentId: number | null;
  /** Parent tag's name, resolved for convenience. Null for root tags. */
  parentName: string | null;
}

export function listTags(
  db: Database.Database,
  opts: { includeArchived?: boolean } = {},
): TagInfo[] {
  // `deleted` is the soft-delete flag used by Vetroscope's sync layer; we
  // never want to surface tombstoned tags. `archived` is the user-facing
  // hide flag — the app keeps archived tags out of every picker/list by
  // default, so we mirror that unless the caller opts in. Older DBs may
  // have neither column.
  const cols = db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>;
  const has = (c: string) => cols.some((col) => col.name === c);
  const hasDeleted = has("deleted");
  const hasSticky = has("sticky");
  const hasArchived = has("archived");
  const hasParent = has("parent_id");

  const conds: string[] = [];
  if (hasDeleted) conds.push("deleted = 0");
  if (hasArchived && !opts.includeArchived) conds.push("archived = 0");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const stickySelect = hasSticky ? "sticky" : "0 AS sticky";
  const archivedSelect = hasArchived ? "archived" : "0 AS archived";
  const parentSelect = hasParent ? "parent_id" : "NULL AS parent_id";

  const rows = db
    .prepare(
      `SELECT id, name, color, ${stickySelect}, ${archivedSelect}, ${parentSelect}
         FROM tags ${where} ORDER BY name COLLATE NOCASE`
    )
    .all() as Array<{ id: number; name: string; color: string; sticky: number; archived: number; parent_id: number | null }>;

  // Resolve parent names. A child's parent may be archived (and thus absent
  // from `rows` when includeArchived is false), so look up any missing
  // parents directly rather than only mapping within the returned set.
  const nameById = new Map<number, string>(rows.map((r) => [r.id, r.name]));
  if (hasParent) {
    const missing = [...new Set(
      rows.map((r) => r.parent_id).filter((v): v is number => v != null && !nameById.has(v)),
    )];
    if (missing.length) {
      const extra = db
        .prepare(`SELECT id, name FROM tags WHERE id IN (${missing.map(() => "?").join(",")})`)
        .all(...missing) as Array<{ id: number; name: string }>;
      for (const e of extra) nameById.set(e.id, e.name);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    sticky: r.sticky === 1,
    archived: r.archived === 1,
    parentId: r.parent_id ?? null,
    parentName: r.parent_id != null ? (nameById.get(r.parent_id) ?? null) : null,
  }));
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

/** Resolve a tag by name (case-insensitive) or numeric id. Returns null if absent.
 *  Includes archived tags so breakdown/stats still work on a tag the user has
 *  since archived — list_tags hides them, but addressing one explicitly is fine. */
function resolveTag(db: Database.Database, identifier: string | number): TagInfo | null {
  const tags = listTags(db, { includeArchived: true });
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
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.tag_id = ?${dash.clause}`;
  const params = [range.start, range.end, tag.id, ...dash.params];
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

// ── get_tag_stats ─────────────────────────────────────────────────────────

/** Transitive child tag ids of `rootId` (excludes the root itself). Walks the
 *  parent_id tree in memory. Returns [] on DBs without a tag hierarchy. */
function getDescendantTagIds(db: Database.Database, rootId: number): number[] {
  const cols = db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "parent_id")) return [];
  const hasDeleted = cols.some((c) => c.name === "deleted");
  const rows = db
    .prepare(`SELECT id, parent_id FROM tags ${hasDeleted ? "WHERE deleted = 0" : ""}`)
    .all() as Array<{ id: number; parent_id: number | null }>;
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    if (r.parent_id == null) continue;
    const arr = childrenOf.get(r.parent_id) ?? [];
    arr.push(r.id);
    childrenOf.set(r.parent_id, arr);
  }
  const out: number[] = [];
  const stack = [...(childrenOf.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    const kids = childrenOf.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

export interface TagStatsResult {
  tag: TagInfo;
  /**
   * Lifetime totals for time DIRECTLY assigned to this tag (children are not
   * rolled in — they're reported separately under `children`). Mirrors how
   * the app's tag stats panel counts the tag's own time.
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
  period: Range & { totalSeconds: number; passiveSeconds: number };
  /** Apps this tag appears under within the period, active/passive split. */
  topApps: AppTotal[];
  /** Daily active seconds within the period. */
  daily: Array<{ date: string; seconds: number }>;
  /** 24-hour distribution of active seconds within the period. */
  hourOfDay: Array<{ hour: number; seconds: number }>;
  /** Day-of-week distribution within the period. 0=Sunday. */
  weekday: Array<{ weekday: number; seconds: number }>;
  /** Immediate parent tag when nested, else null. */
  parent: { id: number; name: string; color: string } | null;
  /** Immediate children, each with lifetime active seconds rolled up across
   *  the child and all of ITS descendants — so the LLM can see how a parent
   *  tag's branches divide up without re-querying. */
  children: Array<{ id: number; name: string; color: string; totalSeconds: number }>;
}

/**
 * Deeper statistics for a single tag — the tag counterpart to get_app_stats.
 * Lifetime + period totals, top apps, daily / hour-of-day / weekday
 * distributions, plus the tag's place in the hierarchy (parent + children
 * with rolled-up totals). Unlike get_app_stats this never returns null for a
 * tag that exists but has no direct time, so pure parent tags still report
 * their children. Returns null only when no tag matches `identifier`.
 */
export function getTagStats(
  db: Database.Database,
  identifier: string | number,
  period = "week",
  device?: string,
): TagStatsResult | null {
  const tag = resolveTag(db, identifier);
  if (!tag) return null;
  const range = parsePeriod(period);
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);
  const dn = (app: string) => displayNames.get(app) ?? null;
  const dash = dashboardEntryClauseAndParams(db, "e", { device });

  // Lifetime — direct-assigned time only (no period filter).
  const lifetimeRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstSeen,
              MAX(e.timestamp) AS lastSeen,
              COUNT(DISTINCT DATE(e.timestamp, 'localtime')) AS daysActive
         FROM entries e
        WHERE e.tag_id = ?${dash.clause}${active}`
    )
    .get(tag.id, ...dash.params) as { seconds: number | null; firstSeen: string | null; lastSeen: string | null; daysActive: number };
  const lifetimePassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE e.tag_id = ?${dash.clause}${passive}`)
    .get(tag.id, ...dash.params) as { seconds: number | null };

  const periodWhere = `e.tag_id = ? AND e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const periodParams = [tag.id, range.start, range.end, ...dash.params];

  const periodActive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active}`)
    .get(...periodParams) as { seconds: number | null };
  const periodPassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${passive}`)
    .get(...periodParams) as { seconds: number | null };

  // Apps under this tag within the period (active + passive merged).
  const activeApps = db
    .prepare(`SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active} GROUP BY e.app_name`)
    .all(...periodParams) as Array<{ app: string; seconds: number }>;
  const passiveApps = db
    .prepare(`SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${passive} GROUP BY e.app_name`)
    .all(...periodParams) as Array<{ app: string; seconds: number }>;
  const appMap = new Map<string, AppTotal>();
  for (const r of activeApps) appMap.set(r.app, { app: r.app, displayName: dn(r.app), seconds: r.seconds, passiveSeconds: 0 });
  for (const r of passiveApps) {
    const existing = appMap.get(r.app);
    if (existing) existing.passiveSeconds = r.seconds;
    else appMap.set(r.app, { app: r.app, displayName: dn(r.app), seconds: 0, passiveSeconds: r.seconds });
  }
  const topApps = [...appMap.values()]
    .sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds));

  const daily = db
    .prepare(`SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active} GROUP BY DATE(e.timestamp, 'localtime') ORDER BY date`)
    .all(...periodParams) as Array<{ date: string; seconds: number }>;

  const hourRows = db
    .prepare(`SELECT CAST(strftime('%H', e.timestamp, 'localtime') AS INTEGER) AS hour, ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active} GROUP BY hour`)
    .all(...periodParams) as Array<{ hour: number; seconds: number }>;
  const hourMap = new Map<number, number>(hourRows.map((r) => [r.hour, r.seconds]));
  const hourOfDay = Array.from({ length: 24 }, (_, h) => ({ hour: h, seconds: hourMap.get(h) ?? 0 }));

  const weekdayRows = db
    .prepare(`SELECT CAST(strftime('%w', e.timestamp, 'localtime') AS INTEGER) AS weekday, ${SECONDS_EXPR} AS seconds FROM entries e WHERE ${periodWhere}${active} GROUP BY weekday`)
    .all(...periodParams) as Array<{ weekday: number; seconds: number }>;
  const wdMap = new Map<number, number>(weekdayRows.map((r) => [r.weekday, r.seconds]));
  const weekday = Array.from({ length: 7 }, (_, w) => ({ weekday: w, seconds: wdMap.get(w) ?? 0 }));

  // Hierarchy. Parent comes off the resolved TagInfo; children are pulled
  // fresh with their rolled-up lifetime active totals.
  const parent = tag.parentId != null
    ? (db.prepare(`SELECT id, name, color FROM tags WHERE id = ?`).get(tag.parentId) as { id: number; name: string; color: string } | undefined) ?? null
    : null;

  const hasParentCol = (db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>).some((c) => c.name === "parent_id");
  const hasDeletedCol = (db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>).some((c) => c.name === "deleted");
  const childRows = hasParentCol
    ? db.prepare(`SELECT id, name, color FROM tags WHERE parent_id = ?${hasDeletedCol ? " AND deleted = 0" : ""} ORDER BY name COLLATE NOCASE`).all(tag.id) as Array<{ id: number; name: string; color: string }>
    : [];
  const children = childRows.map((c) => {
    const branch = [c.id, ...getDescendantTagIds(db, c.id)];
    const placeholders = branch.map(() => "?").join(",");
    const row = db
      .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE e.tag_id IN (${placeholders})${dash.clause}${active}`)
      .get(...branch, ...dash.params) as { seconds: number | null };
    return { id: c.id, name: c.name, color: c.color, totalSeconds: row.seconds ?? 0 };
  });

  const lifeSeconds = lifetimeRow.seconds ?? 0;
  return {
    tag,
    lifetime: {
      totalSeconds: lifeSeconds,
      passiveSeconds: lifetimePassive.seconds ?? 0,
      daysActive: lifetimeRow.daysActive,
      firstSeen: lifetimeRow.firstSeen,
      lastSeen: lifetimeRow.lastSeen,
      avgSecondsPerActiveDay: lifetimeRow.daysActive > 0 ? Math.round(lifeSeconds / lifetimeRow.daysActive) : 0,
    },
    period: { ...range, totalSeconds: periodActive.seconds ?? 0, passiveSeconds: periodPassive.seconds ?? 0 },
    topApps,
    daily,
    hourOfDay,
    weekday,
    parent,
    children,
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
  const dash = dashboardEntryClauseAndParams(db, "e", { device });

  // Lifetime stats — no period filter, just app filter.
  const lifetimeRow = db
    .prepare(
      `SELECT ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstSeen,
              MAX(e.timestamp) AS lastSeen,
              COUNT(DISTINCT DATE(e.timestamp, 'localtime')) AS daysActive
         FROM entries e
        WHERE e.app_name = ?${dash.clause}${active}`
    )
    .get(app, ...dash.params) as { seconds: number | null; firstSeen: string | null; lastSeen: string | null; daysActive: number };
  if (!lifetimeRow.seconds) return null;
  const lifetimePassive = db
    .prepare(`SELECT ${SECONDS_EXPR} AS seconds FROM entries e WHERE e.app_name = ?${dash.clause}${passive}`)
    .get(app, ...dash.params) as { seconds: number | null };

  const periodWhere = `e.app_name = ? AND e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const periodParams = [app, range.start, range.end, ...dash.params];

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
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const where: string[] = ["e.timestamp >= ?", "e.timestamp < ?"];
  const params: (string | number)[] = [range.start, range.end];
  if (dash.clause) {
    where.push(dash.clause.replace(/^ AND /, ""));
    params.push(...dash.params);
  }
  if (opts.app) { where.push("e.app_name = ?"); params.push(opts.app); }
  if (opts.project) { where.push("e.project = ?"); params.push(opts.project); }
  if (opts.tag) { where.push("t.name = ?"); params.push(opts.tag); }

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
  const dash = dashboardEntryClauseAndParams(db, "e", { device });
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const baseParams = [range.start, range.end, ...dash.params];

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
  const dash = dashboardEntryClauseAndParams(db, "e", {});
  const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>;
  const hasDevice = cols.some((c) => c.name === "device_id");
  const hasPlatform = cols.some((c) => c.name === "platform");
  if (!hasDevice) {
    // Single-device DBs that pre-date the device_id migration have nothing
    // meaningful to break out — return a synthetic "this device" total.
    const total = db
      .prepare(
        `SELECT ${SECONDS_EXPR} AS seconds FROM entries e
           WHERE e.timestamp >= ? AND e.timestamp < ?${dash.clause}${activeFilter(db)}`
      )
      .get(range.start, range.end, ...dash.params) as { seconds: number | null };
    return { ...range, totalSeconds: total.seconds ?? 0, devices: [] };
  }
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const where = `e.timestamp >= ? AND e.timestamp < ? AND e.device_id IS NOT NULL${dash.clause}`;
  const params = [range.start, range.end, ...dash.params];

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

// ── get_music_split ──────────────────────────────────────────────────────

/**
 * Default classification, mirrored from Vetroscope's renderer (see
 * `src/components/ProjectRow.tsx` MUSIC_APPS) plus the obvious browser-tab
 * music sites. Both are overridable per-call so the LLM can include
 * YouTube as music, exclude Apple Music, etc., for a specific question.
 */
export const DEFAULT_MUSIC_APPS = ["Spotify", "Apple Music", "Music"];
export const DEFAULT_MUSIC_BROWSER_PROJECTS = [
  "SoundCloud",
  "YouTube Music",
  "Spotify",
  "Apple Music",
  "Bandcamp",
  "Tidal",
  "Pandora",
];
const DEFAULT_BROWSER_APPS = [
  "Google Chrome", "Chromium", "Safari", "Firefox", "Arc",
  "Microsoft Edge", "Brave Browser", "Vivaldi", "Opera", "Zen Browser",
];

export interface MusicSourceTotal {
  /** Either an app name (Spotify) or a browser-music project name (SoundCloud). */
  source: string;
  /** "native" for native music apps, "browser" for music-site projects under a browser. */
  kind: "native" | "browser";
  /** Total seconds the source logged anything (active or passive). */
  totalSeconds: number;
  /** Subset of totalSeconds where a non-music app was simultaneously foreground. */
  whileWorkingSeconds: number;
  /** Subset where no work-foreground app shared the bucket. */
  whileNotWorkingSeconds: number;
}

export interface MusicSplitResult extends Range {
  /** Total tracked seconds in the period (any entry). */
  totalTrackedSeconds: number;
  /** Buckets where music was logging AND a non-music app was foreground. */
  workWithMusicSeconds: number;
  /** Buckets with music but no work foreground — pure listening time. */
  musicOnlySeconds: number;
  /** Buckets with foreground non-music work AND no music logging. */
  workWithoutMusicSeconds: number;
  /**
   * Buckets that are tracked but fit none of the above three — typically
   * passive browser entries that aren't classified as music (e.g. a paused
   * YouTube tab while the user was idle). Add 'YouTube' to
   * music_browser_projects to fold most of this into musicOnly /
   * workWithMusic. The four bucket fields are guaranteed to sum to
   * totalTrackedSeconds.
   */
  otherSeconds: number;
  /** Per-source breakdown of music time, sorted by total desc. */
  bySource: MusicSourceTotal[];
  /** The classifier that was used for this call (lets the LLM verify). */
  classifier: {
    musicApps: string[];
    musicBrowserProjects: string[];
    browserApps: string[];
  };
}

export function getMusicSplit(
  db: Database.Database,
  period: string,
  opts: {
    musicApps?: string[];
    musicBrowserProjects?: string[];
    browserApps?: string[];
    timeFilters?: TimeFilters;
    device?: string;
  } = {}
): MusicSplitResult {
  const range = parsePeriod(period);
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });

  const musicApps = opts.musicApps ?? DEFAULT_MUSIC_APPS;
  const musicBrowserProjects = opts.musicBrowserProjects ?? DEFAULT_MUSIC_BROWSER_PROJECTS;
  const browserApps = opts.browserApps ?? DEFAULT_BROWSER_APPS;

  const baseTimeWhere = `e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const baseTimeParams = [range.start, range.end, ...dash.params];

  // Predicates we'll reuse. Stringified placeholders are inlined into
  // the SQL; values are passed as bind params.
  const musicAppPlaceholders = musicApps.map(() => "?").join(",");
  const browserAppPlaceholders = browserApps.map(() => "?").join(",");
  const musicProjPlaceholders = musicBrowserProjects.map(() => "?").join(",");

  const isMusicEntrySql = musicApps.length === 0 && musicBrowserProjects.length === 0
    ? "0 = 1"
    : [
        musicApps.length > 0
          ? `e.app_name IN (${musicAppPlaceholders})`
          : null,
        musicBrowserProjects.length > 0 && browserApps.length > 0
          ? `(e.app_name IN (${browserAppPlaceholders}) AND e.project IN (${musicProjPlaceholders}))`
          : null,
      ].filter(Boolean).join(" OR ");
  const musicPredicateParams = [
    ...musicApps,
    ...(musicBrowserProjects.length > 0 && browserApps.length > 0
      ? [...browserApps, ...musicBrowserProjects] : []),
  ];

  const isWorkEntrySql = `e.is_passive = 0 AND NOT (${isMusicEntrySql})`;
  const bucket = BUCKET_EXPR;

  // Three bucket sets — distinct 30s windows where each predicate held.
  // INTERSECT/EXCEPT are SQLite-native set operators so the overlap math
  // happens at the SQL layer in one round trip.
  const sql = `
    WITH music_buckets AS (
      SELECT DISTINCT ${bucket} AS b FROM entries e
       WHERE ${baseTimeWhere} AND (${isMusicEntrySql})
    ),
    work_buckets AS (
      SELECT DISTINCT ${bucket} AS b FROM entries e
       WHERE ${baseTimeWhere} AND ${isWorkEntrySql}
    ),
    all_buckets AS (
      SELECT DISTINCT ${bucket} AS b FROM entries e
       WHERE ${baseTimeWhere}
    )
    SELECT
      (SELECT COUNT(*) FROM (SELECT b FROM music_buckets INTERSECT SELECT b FROM work_buckets)) AS workWithMusic,
      (SELECT COUNT(*) FROM (SELECT b FROM music_buckets EXCEPT    SELECT b FROM work_buckets)) AS musicOnly,
      (SELECT COUNT(*) FROM (SELECT b FROM work_buckets  EXCEPT    SELECT b FROM music_buckets)) AS workOnly,
      (SELECT COUNT(*) FROM all_buckets) AS totalTracked
  `;
  // music CTE bind params, then work CTE (which reuses isMusicEntrySql so
  // also needs the music params), then all_buckets (no extra), three times
  // for the WHERE filters and twice more for the music predicate inside.
  const params = [
    ...baseTimeParams, ...musicPredicateParams,    // music_buckets
    ...baseTimeParams, ...musicPredicateParams,    // work_buckets (NOT music)
    ...baseTimeParams,                              // all_buckets
  ];
  const row = db.prepare(sql).get(...params) as {
    workWithMusic: number;
    musicOnly: number;
    workOnly: number;
    totalTracked: number;
  };

  // Per-source breakdown — group music-classified entries by their canonical
  // source label, then count distinct buckets total and distinct buckets
  // overlapping work_buckets. Two queries keep it readable; both round-trip
  // in a few ms.
  const sourceLabel = `CASE
    WHEN e.app_name IN (${musicAppPlaceholders.length ? musicAppPlaceholders : "''"}) THEN e.app_name
    ELSE e.project
  END`;
  const kindLabel = `CASE
    WHEN e.app_name IN (${musicAppPlaceholders.length ? musicAppPlaceholders : "''"}) THEN 'native'
    ELSE 'browser'
  END`;

  const sourceTotalsRows = musicApps.length === 0 && musicBrowserProjects.length === 0 ? [] : db
    .prepare(
      `SELECT ${sourceLabel} AS source, ${kindLabel} AS kind,
              COUNT(DISTINCT ${bucket}) AS buckets
         FROM entries e
        WHERE ${baseTimeWhere} AND (${isMusicEntrySql})
        GROUP BY source, kind`
    )
    .all(
      ...musicApps,                       // sourceLabel CASE
      ...musicApps,                       // kindLabel CASE
      ...baseTimeParams, ...musicPredicateParams,
    ) as Array<{ source: string; kind: "native" | "browser"; buckets: number }>;

  // Same group, but only buckets that are ALSO in work_buckets.
  const sourceWorkOverlapRows = musicApps.length === 0 && musicBrowserProjects.length === 0 ? [] : db
    .prepare(
      `WITH work_buckets AS (
         SELECT DISTINCT ${bucket} AS b FROM entries e
          WHERE ${baseTimeWhere} AND ${isWorkEntrySql}
       )
       SELECT ${sourceLabel} AS source, COUNT(DISTINCT ${bucket}) AS buckets
         FROM entries e
        WHERE ${baseTimeWhere} AND (${isMusicEntrySql})
          AND ${bucket} IN (SELECT b FROM work_buckets)
        GROUP BY source`
    )
    .all(
      ...baseTimeParams, ...musicPredicateParams,   // work_buckets WHERE
      ...musicApps,                                  // sourceLabel CASE
      ...baseTimeParams, ...musicPredicateParams,   // outer WHERE
    ) as Array<{ source: string; buckets: number }>;

  const overlapMap = new Map(sourceWorkOverlapRows.map((r) => [r.source, r.buckets]));
  const bySource: MusicSourceTotal[] = sourceTotalsRows.map((r) => {
    const total = r.buckets * POLL_SECONDS;
    const overlap = (overlapMap.get(r.source) ?? 0) * POLL_SECONDS;
    return {
      source: r.source,
      kind: r.kind,
      totalSeconds: total,
      whileWorkingSeconds: overlap,
      whileNotWorkingSeconds: total - overlap,
    };
  });
  bySource.sort((a, b) => b.totalSeconds - a.totalSeconds);

  return {
    ...range,
    totalTrackedSeconds: row.totalTracked * POLL_SECONDS,
    workWithMusicSeconds: row.workWithMusic * POLL_SECONDS,
    musicOnlySeconds: row.musicOnly * POLL_SECONDS,
    workWithoutMusicSeconds: row.workOnly * POLL_SECONDS,
    // Buckets that aren't in music_buckets ∪ work_buckets — passive browser
    // entries on non-music projects, mostly. Computed by subtraction so the
    // four fields exactly sum to totalTrackedSeconds.
    otherSeconds: (row.totalTracked - row.workWithMusic - row.musicOnly - row.workOnly) * POLL_SECONDS,
    bySource,
    classifier: { musicApps, musicBrowserProjects, browserApps },
  };
}

// ── get_category_breakdown ────────────────────────────────────────────────

export interface CategoryTotal {
  category: AppCategory;
  /** Human label suitable for display ("Code Editors / IDEs"). */
  label: string;
  /** Active foreground seconds across all apps in this category. */
  totalSeconds: number;
  /** Background away-listening seconds (mostly relevant for `media`). */
  passiveSeconds: number;
  /** Apps in this category that contributed time, sorted by seconds desc. */
  apps: AppTotal[];
}

export interface CategoryBreakdownResult extends Range {
  totalSeconds: number;
  totalPassiveSeconds: number;
  categories: CategoryTotal[];
}

/**
 * Rolls up app totals into Vetroscope's broader categories: editors, browsers,
 * Adobe creative cloud, communication, gaming, etc. Apps not in the canonical
 * map land in `uncategorized` so the LLM can see what's missing classification.
 * Same time / device filters as get_report.
 */
export function getCategoryBreakdown(
  db: Database.Database,
  period: string,
  opts: { timeFilters?: TimeFilters; device?: string } = {}
): CategoryBreakdownResult {
  const range = parsePeriod(period);
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const baseParams = [range.start, range.end, ...dash.params];
  const active = activeFilter(db);
  const passive = passiveFilter(db);
  const displayNames = loadDisplayNames(db);

  const activeApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e WHERE ${baseWhere}${active}
        GROUP BY e.app_name`
    )
    .all(...baseParams) as Array<{ app: string; seconds: number }>;
  const passiveApps = db
    .prepare(
      `SELECT e.app_name AS app, ${SECONDS_EXPR} AS seconds
         FROM entries e WHERE ${baseWhere}${passive}
        GROUP BY e.app_name`
    )
    .all(...baseParams) as Array<{ app: string; seconds: number }>;

  const appMap = new Map<string, AppTotal>();
  for (const r of activeApps) {
    appMap.set(r.app, {
      app: r.app, displayName: displayNames.get(r.app) ?? null,
      seconds: r.seconds, passiveSeconds: 0,
    });
  }
  for (const r of passiveApps) {
    const existing = appMap.get(r.app);
    if (existing) existing.passiveSeconds = r.seconds;
    else appMap.set(r.app, {
      app: r.app, displayName: displayNames.get(r.app) ?? null,
      seconds: 0, passiveSeconds: r.seconds,
    });
  }

  const catMap = new Map<AppCategory, CategoryTotal>();
  for (const app of appMap.values()) {
    const cat = categorizeApp(app.app);
    let bucket = catMap.get(cat);
    if (!bucket) {
      bucket = {
        category: cat,
        label: CATEGORY_LABELS[cat],
        totalSeconds: 0,
        passiveSeconds: 0,
        apps: [],
      };
      catMap.set(cat, bucket);
    }
    bucket.totalSeconds += app.seconds;
    bucket.passiveSeconds += app.passiveSeconds;
    bucket.apps.push(app);
  }
  const categories = [...catMap.values()];
  for (const c of categories) {
    c.apps.sort((a, b) => (b.seconds + b.passiveSeconds) - (a.seconds + a.passiveSeconds));
  }
  categories.sort((a, b) => (b.totalSeconds + b.passiveSeconds) - (a.totalSeconds + a.passiveSeconds));

  let total = 0;
  let totalPassive = 0;
  for (const c of categories) {
    total += c.totalSeconds;
    totalPassive += c.passiveSeconds;
  }

  return {
    ...range,
    totalSeconds: total,
    totalPassiveSeconds: totalPassive,
    categories,
  };
}

// ── get_listening_history ─────────────────────────────────────────────────

export interface ListeningTrack {
  /** Format depends on source — Spotify/Apple Music encode "Artist — Title" in sub_project. */
  trackTitle: string;
  /** Best-effort artist parsed from sub_project (text before " — "). Null if unparseable. */
  artist: string | null;
  /** App or browser project that played this track ("Spotify", "SoundCloud"). */
  source: string;
  totalSeconds: number;
  passiveSeconds: number;
  firstHeard: string;
  lastHeard: string;
}

export interface ListeningArtistTotal {
  artist: string;
  totalSeconds: number;
  trackCount: number;
}

export interface ListeningHistoryResult extends Range {
  totalSeconds: number;
  totalPassiveSeconds: number;
  uniqueTracks: number;
  uniqueArtists: number;
  /** Top tracks across all music sources, sorted by totalSeconds desc. */
  topTracks: ListeningTrack[];
  /** Top artists derived from track titles, sorted by totalSeconds desc. */
  topArtists: ListeningArtistTotal[];
  /** Per-day listening minutes. */
  daily: Array<{ date: string; seconds: number }>;
}

/**
 * Aggregates sub_project rows from music sources into top tracks + top
 * artists. Music is identified the same way as get_music_split (native
 * music apps + browser music projects, both override-able).
 */
export function getListeningHistory(
  db: Database.Database,
  period: string,
  opts: {
    musicApps?: string[];
    musicBrowserProjects?: string[];
    browserApps?: string[];
    topTracks?: number;
    topArtists?: number;
    timeFilters?: TimeFilters;
    device?: string;
  } = {}
): ListeningHistoryResult {
  const range = parsePeriod(period);
  if (!hasSubProjectColumn(db)) {
    // sub_project carries the track title; without it there's no listening
    // detail to surface (just app-level totals which the music-split tool
    // already covers).
    return {
      ...range, totalSeconds: 0, totalPassiveSeconds: 0,
      uniqueTracks: 0, uniqueArtists: 0,
      topTracks: [], topArtists: [], daily: [],
    };
  }
  const musicApps = opts.musicApps ?? DEFAULT_MUSIC_APPS;
  const musicBrowserProjects = opts.musicBrowserProjects ?? DEFAULT_MUSIC_BROWSER_PROJECTS;
  const browserApps = opts.browserApps ?? [
    "Google Chrome", "Chromium", "Safari", "Firefox", "Arc",
    "Microsoft Edge", "Brave Browser", "Vivaldi", "Opera", "Zen Browser",
  ];

  const musicAppPlaceholders = musicApps.map(() => "?").join(",");
  const browserAppPlaceholders = browserApps.map(() => "?").join(",");
  const musicProjPlaceholders = musicBrowserProjects.map(() => "?").join(",");
  const isMusicEntrySql = musicApps.length === 0 && musicBrowserProjects.length === 0
    ? "0 = 1"
    : [
        musicApps.length > 0 ? `e.app_name IN (${musicAppPlaceholders})` : null,
        musicBrowserProjects.length > 0 && browserApps.length > 0
          ? `(e.app_name IN (${browserAppPlaceholders}) AND e.project IN (${musicProjPlaceholders}))`
          : null,
      ].filter(Boolean).join(" OR ");
  const musicPredicateParams = [
    ...musicApps,
    ...(musicBrowserProjects.length > 0 && browserApps.length > 0
      ? [...browserApps, ...musicBrowserProjects] : []),
  ];

  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const baseWhere = `e.timestamp >= ? AND e.timestamp < ?${dash.clause}`;
  const baseParams = [range.start, range.end, ...dash.params];
  const active = activeFilter(db);
  const passive = passiveFilter(db);

  // Source label — native music apps keep their app_name, browser music
  // collapses to the project ("SoundCloud") so the same SoundCloud row
  // doesn't split across browsers.
  const sourceLabel = musicApps.length > 0
    ? `CASE WHEN e.app_name IN (${musicAppPlaceholders}) THEN e.app_name ELSE e.project END`
    : `e.project`;

  // Bind order matches placeholder order in the SQL string:
  // (1) SELECT CASE musicApps, (2) WHERE base (timestamp + time/device filters),
  // (3) WHERE musicPredicateParams.
  const trackParams = [...musicApps, ...baseParams, ...musicPredicateParams];
  const tracksActive = db
    .prepare(
      `SELECT e.sub_project AS trackTitle, ${sourceLabel} AS source,
              ${SECONDS_EXPR} AS seconds,
              MIN(e.timestamp) AS firstHeard,
              MAX(e.timestamp) AS lastHeard
         FROM entries e
        WHERE ${baseWhere} AND e.sub_project IS NOT NULL AND e.sub_project != ''
          AND (${isMusicEntrySql})${active}
        GROUP BY e.sub_project, source`
    )
    .all(...trackParams) as Array<{
    trackTitle: string; source: string; seconds: number; firstHeard: string; lastHeard: string;
  }>;
  const tracksPassive = db
    .prepare(
      `SELECT e.sub_project AS trackTitle, ${sourceLabel} AS source,
              ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere} AND e.sub_project IS NOT NULL AND e.sub_project != ''
          AND (${isMusicEntrySql})${passive}
        GROUP BY e.sub_project, source`
    )
    .all(...trackParams) as Array<{
    trackTitle: string; source: string; seconds: number;
  }>;

  const trackMap = new Map<string, ListeningTrack>();
  const tkey = (t: string, s: string) => `${t}\0${s}`;
  for (const r of tracksActive) {
    // sub_project from Spotify/Apple Music conventionally uses an em-dash
    // separator: "Artist — Title". We fall back to splitting on " - " or
    // " by " for sources that use those instead. Anything we can't parse
    // gets a null artist and surfaces as-is.
    const artist = parseArtist(r.trackTitle);
    trackMap.set(tkey(r.trackTitle, r.source), {
      trackTitle: r.trackTitle,
      artist,
      source: r.source,
      totalSeconds: r.seconds,
      passiveSeconds: 0,
      firstHeard: r.firstHeard,
      lastHeard: r.lastHeard,
    });
  }
  for (const r of tracksPassive) {
    const k = tkey(r.trackTitle, r.source);
    const existing = trackMap.get(k);
    if (existing) existing.passiveSeconds = r.seconds;
    else {
      const artist = parseArtist(r.trackTitle);
      trackMap.set(k, {
        trackTitle: r.trackTitle, artist, source: r.source,
        totalSeconds: 0, passiveSeconds: r.seconds,
        firstHeard: "", lastHeard: "",
      });
    }
  }
  const allTracks = [...trackMap.values()].sort((a, b) =>
    (b.totalSeconds + b.passiveSeconds) - (a.totalSeconds + a.passiveSeconds));

  // Artist rollup over the same data.
  const artistMap = new Map<string, ListeningArtistTotal>();
  for (const t of allTracks) {
    if (!t.artist) continue;
    let a = artistMap.get(t.artist);
    if (!a) { a = { artist: t.artist, totalSeconds: 0, trackCount: 0 }; artistMap.set(t.artist, a); }
    a.totalSeconds += t.totalSeconds + t.passiveSeconds;
    a.trackCount += 1;
  }
  const artists = [...artistMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);

  const totalSeconds = allTracks.reduce((acc, t) => acc + t.totalSeconds, 0);
  const totalPassiveSeconds = allTracks.reduce((acc, t) => acc + t.passiveSeconds, 0);

  // Daily series — total music time per day (active + passive combined,
  // since daily listening minutes feel more natural as a single number).
  const dailyRows = db
    .prepare(
      `SELECT DATE(e.timestamp, 'localtime') AS date, ${SECONDS_EXPR} AS seconds
         FROM entries e
        WHERE ${baseWhere} AND (${isMusicEntrySql})
        GROUP BY DATE(e.timestamp, 'localtime')
        ORDER BY date`
    )
    .all(...baseParams, ...musicPredicateParams) as Array<{ date: string; seconds: number }>;

  return {
    ...range,
    totalSeconds, totalPassiveSeconds,
    uniqueTracks: allTracks.length,
    uniqueArtists: artists.length,
    topTracks: allTracks.slice(0, opts.topTracks ?? 50),
    topArtists: artists.slice(0, opts.topArtists ?? 25),
    daily: dailyRows,
  };
}

function parseArtist(trackTitle: string): string | null {
  // Em-dash separator (Spotify / Apple Music / SoundCloud convention).
  const em = trackTitle.split(" — ");
  if (em.length >= 2 && em[0].trim().length > 0) return em[0].trim();
  // Plain ASCII " - " fallback.
  const dash = trackTitle.split(" - ");
  if (dash.length >= 2 && dash[0].trim().length > 0) return dash[0].trim();
  // " by " fallback (less common, e.g. Bandcamp pages).
  const by = trackTitle.split(/\s+by\s+/i);
  if (by.length >= 2 && by[1].trim().length > 0) return by[1].trim();
  return null;
}

// ── get_focus_heatmap ─────────────────────────────────────────────────────

export interface HeatmapCell {
  /** 0=Sunday, 1=Monday, …, 6=Saturday. */
  weekday: number;
  /** 0–23 in local time. */
  hour: number;
  seconds: number;
}

export interface FocusHeatmapResult extends Range {
  /**
   * Dense 7×24 = 168 cells. Always returned in (weekday, hour) order so the
   * LLM can index directly: cells[weekday * 24 + hour].
   */
  cells: HeatmapCell[];
  /** Maximum seconds in any single cell — useful for normalizing displays. */
  maxCellSeconds: number;
  /** Sum across all cells (matches the period's active total under the same filters). */
  totalSeconds: number;
}

/**
 * Joint hour-of-day × weekday distribution. Reveals "I code on Mondays
 * 9–11am" or "I game Sundays 8pm" patterns the marginal hour and weekday
 * histograms in get_app_stats can't show. Optional app / project / tag
 * filters narrow it to a single activity. Active foreground time only —
 * passive music doesn't smear the productivity peaks.
 */
export function getFocusHeatmap(
  db: Database.Database,
  period: string,
  opts: {
    app?: string;
    project?: string;
    tag?: string;
    device?: string;
  } = {}
): FocusHeatmapResult {
  const range = parsePeriod(period);
  const dash = dashboardEntryClauseAndParams(db, "e", { device: opts.device });
  const where: string[] = ["e.timestamp >= ?", "e.timestamp < ?"];
  const params: (string | number)[] = [range.start, range.end];
  if (dash.clause) {
    where.push(dash.clause.replace(/^ AND /, ""));
    params.push(...dash.params);
  }
  if (opts.app) { where.push("e.app_name = ?"); params.push(opts.app); }
  if (opts.project) { where.push("e.project = ?"); params.push(opts.project); }
  // Tag filter requires a JOIN — handled separately so we don't pay for it
  // when the caller doesn't ask for it.
  const joinTags = opts.tag ? "INNER JOIN tags t ON t.id = e.tag_id" : "";
  if (opts.tag) { where.push("t.name = ?"); params.push(opts.tag); }

  const active = activeFilter(db);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', e.timestamp, 'localtime') AS INTEGER) AS weekday,
              CAST(strftime('%H', e.timestamp, 'localtime') AS INTEGER) AS hour,
              ${SECONDS_EXPR} AS seconds
         FROM entries e
         ${joinTags}
        WHERE ${where.join(" AND ")}${active}
        GROUP BY weekday, hour`
    )
    .all(...params) as Array<{ weekday: number; hour: number; seconds: number }>;

  // Densify to 168 cells in (weekday, hour) order so cells[w*24 + h] indexes
  // directly. Missing combinations get 0 seconds rather than being absent.
  const cellMap = new Map<number, number>();
  for (const r of rows) cellMap.set(r.weekday * 24 + r.hour, r.seconds);
  const cells: HeatmapCell[] = [];
  let max = 0;
  let total = 0;
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const seconds = cellMap.get(w * 24 + h) ?? 0;
      cells.push({ weekday: w, hour: h, seconds });
      if (seconds > max) max = seconds;
      total += seconds;
    }
  }

  return { ...range, cells, maxCellSeconds: max, totalSeconds: total };
}

// ── get_media_links ───────────────────────────────────────────────────────

export type MediaLinkKind = "spotify_track" | "youtube_watch";

/**
 * Convert the captured URI to its HTTPS equivalent. Spotify track URIs
 * (`spotify:track:<id>`) become the open.spotify.com web player form,
 * which auto-redirects to the Spotify desktop app when it's installed.
 * YouTube captures are already HTTPS so they pass through unchanged.
 * The track-ID regex matches Spotify's canonical 22-char base62, but
 * we accept anything `[A-Za-z0-9]{16,32}` to match the desktop
 * capture-side canonicalizer's tolerance.
 */
function deriveMediaWebUrl(url: string, kind: MediaLinkKind): string {
  if (kind === "spotify_track") {
    const m = /^spotify:track:([A-Za-z0-9]{16,32})$/.exec(url);
    if (m) return `https://open.spotify.com/track/${m[1]}`;
  }
  return url;
}

export interface MediaLinkResult {
  app: string;
  /** Custom app display name when the user has set one, else null. */
  displayName: string | null;
  /**
   * For Spotify the project IS the song ("Artist — Track") and
   * `subProject` is null. For YouTube watch pages the project is the
   * site label ("YouTube") and the video title lives in `subProject`.
   */
  project: string;
  subProject: string | null;
  /**
   * Canonical URI as captured by Vetroscope — `spotify:track:<id>` for
   * Spotify, `https://www.youtube.com/watch?v=<id>` for YouTube. Works
   * with `shell.openExternal()` / `open(1)` (the desktop app and your
   * terminal will route the scheme correctly). Some web renderers
   * filter custom schemes for security; use `webUrl` instead when you
   * need a link that always survives clipboard / chat / browser
   * round-trips.
   */
  url: string;
  /**
   * HTTPS equivalent of `url` — always safe to render as a clickable
   * link in any markdown renderer / web UI. For Spotify this is the
   * `https://open.spotify.com/track/<id>` form (the Spotify web player
   * page, which hands off to the desktop app via deep-link when it's
   * installed). For YouTube this is the same as `url` since the
   * captured form is already HTTPS.
   */
  webUrl: string;
  kind: MediaLinkKind;
  /** Total foreground time the user spent on this media within the period. */
  totalSeconds: number;
  /** Background away-listening / muted-tab time within the period. */
  passiveSeconds: number;
  /** Distinct local-date days this media appeared on. */
  daysActive: number;
  /** ISO timestamp of the first capture (lifetime, not period-scoped). */
  firstSeen: string;
  /** ISO timestamp of the most recent observation (lifetime). */
  lastSeen: string;
}

export interface MediaLinksResult {
  /** Always present, even when the install predates the feature. */
  available: boolean;
  /** Total rows captured across all kinds, period-scoped to entries when set. */
  totalRows: number;
  links: MediaLinkResult[];
}

/**
 * List captured media links (Spotify track URIs + YouTube /watch URLs)
 * joined with entry-level time data. Requires Vetroscope ≥ 0.2.30 with
 * `capture_media_links` turned on; returns `available: false` and an
 * empty array on older installs or when nothing has been captured yet.
 *
 * Optional `period` scopes the joined time totals to a window — the
 * same dashboard filter stack as get_report applies, so totals match
 * Charts. Without `period` the time columns are lifetime totals across
 * every entry the link's (app, project, sub_project) tuple has matched.
 */
export function getMediaLinks(
  db: Database.Database,
  opts: {
    kind?: MediaLinkKind;
    period?: string;
    search?: string;
    limit?: number;
    device?: string;
    timeFilters?: TimeFilters;
  } = {}
): MediaLinksResult {
  if (!hasMediaLinksTable(db)) {
    return { available: false, totalRows: 0, links: [] };
  }

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.kind) { where.push("ml.kind = ?"); params.push(opts.kind); }
  if (opts.search) {
    where.push("(LOWER(ml.project) LIKE ? OR LOWER(ml.sub_project) LIKE ? OR LOWER(ml.app_name) LIKE ?)");
    const term = `%${opts.search.toLowerCase()}%`;
    params.push(term, term, term);
  }
  const baseWhere = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // Period-scoped time join when requested. The same dashboard filter
  // stack as the rest of the MCP applies; total seconds line up with
  // get_report. Without a period we sum across every matching entry
  // (lifetime), still honoring ignored apps / projects / patterns and
  // optional device / hour / weekday filters.
  const range = opts.period ? parsePeriod(opts.period) : null;
  const dash = dashboardEntryClauseAndParams(db, "e", {
    timeFilters: opts.timeFilters,
    device: opts.device,
  });
  const dateClause = range ? "e.timestamp >= ? AND e.timestamp < ? AND " : "";
  const dateParams = range ? [range.start, range.end] : [];
  const active = activeFilter(db);
  const passive = passiveFilter(db);

  const linkRows = db
    .prepare(
      `SELECT ml.app_name AS app, ml.project AS project,
              ml.sub_project AS subProject,
              ml.url AS url, ml.kind AS kind,
              ml.first_seen AS firstSeen, ml.last_seen AS lastSeen,
              COALESCE(
                (SELECT ${SECONDS_EXPR}
                   FROM entries e
                  WHERE ${dateClause}e.app_name = ml.app_name
                    AND e.project = ml.project
                    AND COALESCE(e.sub_project, '') = ml.sub_project${dash.clause}${active}
                ), 0
              ) AS activeSeconds,
              COALESCE(
                (SELECT ${SECONDS_EXPR}
                   FROM entries e
                  WHERE ${dateClause}e.app_name = ml.app_name
                    AND e.project = ml.project
                    AND COALESCE(e.sub_project, '') = ml.sub_project${dash.clause}${passive}
                ), 0
              ) AS passiveSeconds,
              COALESCE(
                (SELECT COUNT(DISTINCT DATE(e.timestamp, 'localtime'))
                   FROM entries e
                  WHERE ${dateClause}e.app_name = ml.app_name
                    AND e.project = ml.project
                    AND COALESCE(e.sub_project, '') = ml.sub_project${dash.clause}
                ), 0
              ) AS daysActive
         FROM media_links ml
         ${baseWhere}`
    )
    // The three correlated subqueries reuse the same date / device /
    // hour params, so we splat them three times before the WHERE
    // clause params.
    .all(
      ...dateParams, ...dash.params,
      ...dateParams, ...dash.params,
      ...dateParams, ...dash.params,
      ...params,
    ) as Array<{
      app: string; project: string; subProject: string;
      url: string; kind: string;
      firstSeen: string; lastSeen: string;
      activeSeconds: number; passiveSeconds: number; daysActive: number;
    }>;

  const displayNames = loadDisplayNames(db);

  // Sort by total time within the period desc. Lifetime first/last
  // seen stays in the response so callers can spot stale captures
  // without re-querying.
  const ranked = linkRows
    .map<MediaLinkResult>((r) => ({
      app: r.app,
      displayName: displayNames.get(r.app) ?? null,
      // Spotify stores the song as project with sub_project = ''.
      // Normalize the empty-string sentinel back to null on the wire.
      project: r.project,
      subProject: r.subProject === "" ? null : r.subProject,
      url: r.url,
      webUrl: deriveMediaWebUrl(r.url, r.kind as MediaLinkKind),
      kind: r.kind as MediaLinkKind,
      totalSeconds: r.activeSeconds,
      passiveSeconds: r.passiveSeconds,
      daysActive: r.daysActive,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))
    .sort((a, b) =>
      (b.totalSeconds + b.passiveSeconds) - (a.totalSeconds + a.passiveSeconds)
    );

  const limit = opts.limit ?? 100;
  return {
    available: true,
    totalRows: ranked.length,
    links: ranked.slice(0, limit),
  };
}
