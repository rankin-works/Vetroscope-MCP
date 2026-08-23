/**
 * Regression: an ignored named project must not drop NULL-project rows
 * for the same app (Cursor Agents).
 *
 * Import the compiled queries module (`npm run build` first) so this
 * exercises the real clause, not a copy of the SQL.
 */
import Database from "better-sqlite3";
import { getReport, queryEntries } from "../dist/queries.js";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, color TEXT);
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    timestamp TEXT,
    app_name TEXT,
    window_title TEXT,
    project TEXT,
    sub_project TEXT,
    is_passive INTEGER DEFAULT 0,
    tag_id INTEGER,
    device_id TEXT,
    platform TEXT
  );
  INSERT INTO settings (key, value) VALUES
    ('ignored_apps', '[]'),
    ('ignored_projects', '[{"appName":"Cursor","project":".env.example"}]'),
    ('ignored_breakdown_patterns', '[]'),
    ('days_filter', 'all');
`);

const noon = new Date("2026-08-22T12:00:00");
const t0 = noon.toISOString();
const t1 = new Date(noon.getTime() + 30_000).toISOString();
const t2 = new Date(noon.getTime() + 60_000).toISOString();
db.prepare(
  `INSERT INTO entries (timestamp, app_name, window_title, project, is_passive, platform) VALUES
    (?, 'Cursor', 'Cursor Agents', NULL, 0, 'win32'),
    (?, 'Cursor', 'iconCache.ts - vetroscope - Cursor', 'vetroscope', 0, 'win32'),
    (?, 'Cursor', '.env.example - vetroscope - Cursor', '.env.example', 0, 'win32')`,
).run(t0, t1, t2);

const report = getReport(db, "2026-08-22");
const cursor = report.apps.find((a) => a.app === "Cursor");
if (!cursor) {
  console.error("expected Cursor in get_report");
  process.exit(1);
}
if (cursor.seconds !== 60) {
  console.error(`expected Cursor 60s (Agents + vetroscope), got ${cursor.seconds}`);
  process.exit(1);
}
const rows = queryEntries(db, { period: "2026-08-22", app: "Cursor", limit: 50 });
if (rows.length !== 2) {
  console.error(`expected 2 scoped Cursor rows, got ${rows.length}`);
  process.exit(1);
}
if (!rows.some((r) => r.project == null)) {
  console.error("expected a null-project Cursor Agents row to survive scoping");
  process.exit(1);
}

const buggy = db.prepare(
  `SELECT COUNT(*) AS n FROM entries
    WHERE app_name = 'Cursor'
      AND NOT (app_name = 'Cursor' AND project = '.env.example')`,
).get();
const fixed = db.prepare(
  `SELECT COUNT(*) AS n FROM entries
    WHERE app_name = 'Cursor'
      AND NOT (app_name = 'Cursor' AND project IS NOT NULL AND project = '.env.example')`,
).get();
if (buggy.n !== 1) {
  console.error(`control: buggy clause should keep 1 row, got ${buggy.n}`);
  process.exit(1);
}
if (fixed.n !== 2) {
  console.error(`control: fixed clause should keep 2 rows, got ${fixed.n}`);
  process.exit(1);
}

console.log("ok: null-project Cursor rows survive ignored_projects scoping");
