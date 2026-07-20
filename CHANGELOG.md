# Changelog

All notable changes to **vetroscope-mcp** will be documented here. This project follows [Semantic Versioning](https://semver.org/) starting with 1.0.0.

## 1.5.0 — 2026-07-20

### Added

- **New tools: `list_reminders` and `list_reminder_events`.** List configured one-time, recurring weekday, and tag-threshold reminders, plus their notification history. Reminder events can be filtered by period, unread status, or reminder UUID; configured reminders can include disabled rows on request. Both tools degrade to an empty list against Vetroscope databases that predate the reminder tables, and omit large notification icon data URLs.

## 1.4.0 — 2026-06-20

### Added

- **`include_descendants` option on `get_tag_stats`, `get_tag_breakdown`, and `get_focus_heatmap`.** Set it to roll a parent tag's whole subtree (the tag plus all of its nested children) into the result instead of counting only directly-assigned time. This is the right way to ask "how did I spend time under this parent tag, by hour/day?" — previously a parent tag (whose time lives in its children) returned almost nothing and you had to sum the descendants by hand. `get_tag_stats` also gains an `includesDescendants` boolean on the result so consumers know which mode produced the totals; its `children` list still reports each immediate child's own subtree total either way.

### Changed

- **`get_focus_heatmap` now matches its `tag` filter by name (case-insensitive) or numeric id**, consistent with `get_tag_breakdown` / `get_tag_stats`. Previously it required an exact, case-sensitive tag-name match. An unrecognized tag now yields an empty grid rather than being silently ignored.

## 1.3.0 — 2026-06-20

### Added

- **New tool: `get_tag_stats`.** The tag counterpart to `get_app_stats`. Returns lifetime totals (days active, first/last seen, average per active day), period totals, top apps under the tag, a daily series, and hour-of-day (24 buckets) / weekday (7 buckets) distributions — plus the tag's place in the hierarchy: its parent and its immediate children with totals rolled up across each child and all of its descendants. The tag's own totals count directly-assigned time only (children are reported separately), matching the app's tag-stats panel. Unlike `get_app_stats`, it never returns null for a tag that exists but has no direct time, so a pure parent tag still reports its children.

### Changed

- **`list_tags` now reflects the tag hierarchy and hides archived tags.** Each tag gains `archived`, `parentId`, and `parentName` fields. Archived tags are now excluded by default to match the app (pass `include_archived: true` to see them). Previously archived tags were surfaced as if active and nested tags carried no parent information, so an LLM had no way to reason about Vetroscope's tag tree.

### Notes

- `parentId` / `parentName` / `archived` come from the `parent_id` and `archived` columns added to the `tags` table in later Vetroscope releases; on older databases without those columns the fields are reported as `null` / `false` and archived filtering is skipped.

## 1.2.0 — 2026-05-15

### Added

- **`webUrl` field on `get_media_links` results.** Always an HTTPS URL — `https://open.spotify.com/track/<id>` for Spotify (which hands off to the Spotify desktop app via deep-link when installed) and the same as `url` for YouTube (already HTTPS). Use `webUrl` whenever the consumer's renderer might strip non-`http(s)` schemes (most chat / markdown renderers do this by default for security). `url` keeps the captured canonical URI — pass that to `shell.openExternal()` / `open(1)` when you want the OS handler chain.

## 1.1.0 — 2026-05-15

### Added

- **New tool: `get_media_links`.** Lists canonical deep-links Vetroscope captured for media the user actually played — Spotify `spotify:track:…` URIs and YouTube `https://www.youtube.com/watch?v=…` URLs — joined with the matching time data. Supports the same `period` / `device` / `hour` / `weekday` filters as `get_report`, plus `kind` (`spotify_track` | `youtube_watch`) and a case-insensitive `search` for fuzzy "find the Beyoncé track" lookups. With `period` set, time totals use the same dashboard filter stack so they match Charts; without `period`, time columns are lifetime totals. Returns `available: false` on installs that predate the feature.
- **`url` field on `SubProjectTotal`.** `get_report` and `get_app_breakdown` now surface the captured YouTube watch URL alongside each nested sub-project row when one exists. Null when the user hasn't enabled `capture_media_links`, the sub-project is from a non-supported source, or the install predates the feature.

### Requirements

- The new tool and the `url` field require **Vetroscope ≥ 0.2.30** with the `capture_media_links` setting enabled. URLs are filtered strictly at capture time on the desktop side (YouTube `/watch` only, with the video ID validated to 11 chars; Spotify track URIs only — no ads, no shorts, no channel pages, no tracking params), so anything returned here is safe to open directly.

## 1.0.1 — 2026-05-09

### Fixed

- **Period totals now honor every dashboard exclusion, not just `ignored_apps`.** The desktop app filters report totals by `ignored_apps` *and* `ignored_projects` (explicit `(app, project)` pairs) *and* `ignored_breakdown_patterns` (substring / extension patterns per app, e.g. Cursor `.tsx` files) *and* the `days_filter` setting (`weekdays` / `weekends` / `all`). The MCP was only honoring `ignored_apps`, so totals diverged from Charts / Dashboard for users with the other filters configured. All period-aware tools — `get_report`, `get_app_breakdown`, `get_app_stats`, `get_tag_breakdown`, `get_calendar`, `get_device_breakdown`, `get_sessions`, `get_music_split`, `get_category_breakdown`, `get_listening_history`, `get_focus_heatmap`, `get_goals_progress`, and `query_entries` (when `period` is set) — now apply the full filter stack via a shared `dashboardEntryClauseAndParams` helper so totals stay consistent across tools and with the dashboard.
- `query_entries` description updated to document the period-vs-no-period scope distinction: with a period, dashboard exclusions apply; without one, the call bypasses them and only the explicit filter args (app / project / tag / search / device / hour / weekdays / mode) narrow the result.
- `get_report` description updated to enumerate the filters it now applies.

### Notes

- This is a behavioral fix, not an API change. Tool names, parameter names, and response field names are unchanged. Users without `ignored_projects` / `ignored_breakdown_patterns` / a non-`all` `days_filter` configured will see identical totals.

## 1.0.0 — 2026-05-09

First stable release. The 18-tool surface, parameter names, and response shapes documented in the README are now part of the SemVer contract — see the **Stability guarantees** section there for what changes are minor vs major.

### Tool surface

**Reports & breakdowns**

- `get_report` — period totals, top apps, top projects (with sub-projects nested for music, video, and other browser-tracked content)
- `get_app_breakdown` — per-project breakdown for a single app, with sub-projects
- `get_app_stats` — lifetime + period stats for one app: days active, daily series, hour-of-day distribution, weekday distribution, top projects
- `get_tag_breakdown` — time under a tag for any period, with apps + projects + daily series
- `get_calendar` — dense per-day series (heatmap data) for any period; defaults to a full year
- `get_device_breakdown` — per-device totals for multi-machine users
- `get_music_split` — work-with-music / music-only / heads-down-work / other, with per-source overlap
- `get_category_breakdown` — apps rolled up into editor / browser / adobe / communication / gaming / etc.
- `get_listening_history` — top tracks + top artists across native music apps and browser music sites
- `get_focus_heatmap` — 7×24 grid of active foreground seconds, optionally filtered to one app / project / tag

**Reference**

- `list_tags` — all tags with id, name, color, sticky flag
- `list_projects` — every project ever tracked with first/last seen + total time + days active + optional substring search
- `list_markers` — user-placed timeline markers, with optional period overlap filter

**Activity**

- `get_sessions` — continuous activity blocks reconstructed from raw entries
- `get_current_status` — most recent entry: app, project, tracking vs idle
- `query_entries` — filtered raw 30s entries; deviceId + platform on each row

**Goals**

- `get_goals_progress` — current progress on app / overall / tag goals
- `get_goal_achievements` — historical record of goals hit on which days

### Shared filters

All time-aware tools accept the same shared filters:

- `period` — `today` · `yesterday` · `week` · `month` · `year` · single date `YYYY-MM-DD` · inclusive range `YYYY-MM-DD..YYYY-MM-DD`
- `hour_start` / `hour_end` — local-time hour-of-day filter (half-open)
- `weekdays` — array of weekday integers (0=Sun, …, 6=Sat)
- `device` — `current`, a UUID from `get_device_breakdown`, or a platform name (`darwin`, `win32`, `browser-extension`)

### Behavior guarantees

- Every total is split into **active** foreground time and **passive** away-listening time, matching the desktop dashboard's distinction.
- Goal progress is active-only, matching `getGoalProgress` in `electron/database.ts`.
- The MCP opens the database **read-only** (`PRAGMA query_only = ON`). It cannot modify Vetroscope's tracking data.
- Auto-resolution of the active database file via `auth-state.json`. Override with `VETROSCOPE_DIR` or `VETROSCOPE_DB_PATH`.

---

## Pre-1.0 history (development log, not under SemVer)

### 0.6.1 — Adobe app name normalization

- `normalizeAppName` helper in `categories.ts` strips `"Adobe "` prefix and trailing 4-digit year suffix; categorizer falls back to normalized form so version-suffixed entries (e.g. `"Adobe Photoshop 2025"`) bucket correctly.
- Three new categories: `ai` (Claude, ChatGPT, Perplexity, …), `time_tracker` (Timing, Rize, …), `first_party` (Vetroscope, Oversight).
- Filled missing canonical entries: virtualization (UTM, Tailscale, Parallels, …), creative (Screen Studio, CleanShot X, LosslessCut, Final Cut Pro, …), office (Microsoft-prefixed alternates + iWork), system (18 macOS bundled utilities).

### 0.6.0 — Categories, listening history, focus heatmap

- `get_category_breakdown` — app totals rolled up into Vetroscope's internal groupings.
- `get_listening_history` — top tracks + top artists from `entries.sub_project` for music sources; artists parsed from the `"Artist — Title"` convention.
- `get_focus_heatmap` — 7×24 grid of active foreground seconds; optional app / project / tag filter.

### 0.5.0 — Music vs work split

- `get_music_split` — bucket-overlap analysis classifying tracked time into work-with-music / music-only / heads-down-work / other. Per-source breakdown with whileWorking vs whileNotWorking. Classifier (native music apps + browser music projects) overridable per call.

### 0.4.1 — Author attribution metadata fix

- Republishes `0.4.0` content with corrected `package.json` author field.

### 0.4.0 — Device filtering

- `device` argument added to all entry-querying tools: `get_report`, `get_app_breakdown`, `get_app_stats`, `get_tag_breakdown`, `get_sessions`, `get_calendar`, `query_entries`. Accepts `current`, a UUID, or a platform name.
- `query_entries` rows include `deviceId` and `platform` per entry.

### 0.3.0 — Markers, sessions, status, achievements, projects, calendar, devices

- Seven new tools: `list_markers`, `get_sessions`, `get_current_status`, `get_goal_achievements`, `list_projects`, `get_calendar`, `get_device_breakdown`.

### 0.2.0 — Tags + app stats + time filters

- Three new tools: `list_tags`, `get_tag_breakdown`, `get_app_stats`.
- Hour-of-day / weekday filters added to `get_report`, `get_app_breakdown`, `get_tag_breakdown`, `query_entries`.
- `query_entries` gains a `tag` argument.

### 0.1.1 — Vetroscope app icon

- Embedded the Vetroscope logo (128×128 + 256×256 PNGs) as data URIs in `serverInfo.icons` so MCP clients render the icon next to the connector. `serverInfo.title`, `description`, and `websiteUrl` also populated.

### 0.1.0 — Initial release

- Stdio MCP server distributed via `npx`. Reads `~/Library/Application Support/Vetroscope/vetroscope[-<userId>].db` (and Windows / Linux equivalents) read-only.
- Four tools: `get_report`, `get_app_breakdown`, `get_goals_progress`, `query_entries`.
- Mirrors the bucket-distinct seconds math from `electron/database.ts` so totals match the desktop dashboard exactly.
- Active vs passive split everywhere, with `is_passive` schema detection so older Vetroscope DBs degrade gracefully.
- Tag goals + custom app `display_name` overrides + `sub_project` (third-tier) breakdowns.
