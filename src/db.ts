import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Returns the per-OS Vetroscope app-data directory. Mirrors Electron's
 * `app.getPath("userData")` for the "Vetroscope" product name.
 */
export function getVetroscopeDir(): string {
  const override = process.env.VETROSCOPE_DIR;
  if (override) return override;

  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Vetroscope");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Vetroscope");
    default:
      // Linux / other: follow XDG-ish layout
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Vetroscope");
  }
}

/**
 * Resolves the active Vetroscope SQLite path. If the user is signed into an
 * account, the active DB is `vetroscope-<userId>.db` (recorded in
 * `auth-state.json`). Otherwise it's the anonymous `vetroscope.db`.
 *
 * Honors `VETROSCOPE_DB_PATH` to point at an explicit file (useful for
 * testing or unusual installs).
 */
export function resolveDbPath(): string {
  const explicit = process.env.VETROSCOPE_DB_PATH;
  if (explicit) return explicit;

  const dir = getVetroscopeDir();

  // Pick the active account's DB filename (anonymous default otherwise).
  // auth-state.json stays in the root regardless of where the DBs live.
  let file = "vetroscope.db";
  const authStatePath = join(dir, "auth-state.json");
  if (existsSync(authStatePath)) {
    try {
      const raw = readFileSync(authStatePath, "utf-8");
      const parsed = JSON.parse(raw) as { activeUserId?: string | null };
      if (parsed.activeUserId) {
        file = `vetroscope-${parsed.activeUserId}.db`;
      }
    } catch {
      // fall through to anonymous DB
    }
  }

  // Newer app versions nest the DB files under a Data/ subfolder. Prefer that,
  // but fall back to the legacy root location so this MCP still works against an
  // app install that hasn't migrated yet.
  const dataPath = join(dir, "Data", file);
  if (existsSync(dataPath)) return dataPath;
  return join(dir, file);
}

export function openDb(path = resolveDbPath()): Database.Database {
  if (!existsSync(path)) {
    throw new Error(
      `Vetroscope database not found at ${path}. ` +
        `Make sure Vetroscope is installed and has been run at least once. ` +
        `You can override the path with VETROSCOPE_DB_PATH.`
    );
  }
  // Read-only — the MCP must never mutate the user's tracking data.
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // Match Vetroscope's pragmas where they affect read concurrency / format.
  // WAL is set by the writer; readers don't need to touch it. We do disable
  // mmap to keep memory predictable for short-lived MCP processes.
  db.pragma("query_only = ON");
  return db;
}
