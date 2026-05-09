/**
 * Canonical app → category mapping, mirroring how Vetroscope groups apps
 * internally in `electron/tracker/knownApps.ts`. The `kind` field on each
 * `KnownApp` is sparse (only set for some categories), so we re-derive the
 * mapping from the array each app lives in there. Imported as data —
 * a Vetroscope release that adds new apps won't break the MCP, those
 * apps just get bucketed into "uncategorized" until the map is updated.
 */
export type AppCategory =
  | "adobe"
  | "editor"
  | "dev_tools"
  | "browser"
  | "communication"
  | "office"
  | "terminal"
  | "design"
  | "media"
  | "productivity"
  | "system"
  | "virtualization"
  | "music_creation"
  | "creative"
  | "launcher"
  | "gaming"
  | "ai"
  | "time_tracker"
  | "first_party"
  | "misc"
  | "uncategorized";

export const CATEGORY_LABELS: Record<AppCategory, string> = {
  adobe: "Adobe Creative Cloud",
  editor: "Code Editors / IDEs",
  dev_tools: "Developer Tools",
  browser: "Web Browsers",
  communication: "Communication / Chat",
  office: "Office Suite",
  terminal: "Terminals",
  design: "Design Tools",
  media: "Media Playback",
  productivity: "Productivity / Notes",
  system: "OS / System Apps",
  virtualization: "Virtualization / Remote",
  music_creation: "Music Production (DAWs)",
  creative: "Creative / 3D / Video",
  launcher: "Game Launchers",
  gaming: "Games",
  ai: "AI Assistants",
  time_tracker: "Time Trackers",
  first_party: "Vetroscope (first-party)",
  misc: "Misc",
  uncategorized: "Uncategorized",
};

const ADOBE = [
  "After Effects", "Premiere Pro", "Photoshop", "Illustrator", "InDesign",
  "Media Encoder", "Audition", "Animate", "Lightroom", "Lightroom Classic",
  "Bridge", "Adobe XD", "Adobe Acrobat",
];
const EDITOR = [
  "VS Code", "Cursor", "Sublime Text", "Notepad++", "IntelliJ IDEA", "PyCharm",
  "WebStorm", "Rider", "GoLand", "CLion", "PhpStorm", "RubyMine", "DataGrip",
  "Android Studio", "Visual Studio", "Xcode",
];
const DEV_TOOLS = [
  "GitHub Desktop", "Sourcetree", "Docker Desktop", "Postman", "Insomnia",
  "DBeaver", "TablePlus", "MongoDB Compass", "Fork",
];
const BROWSER = [
  "Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser", "Opera",
  "Vivaldi", "Arc", "Safari", "Chromium", "Orion", "Zen Browser",
];
const COMMUNICATION = [
  "Slack", "Discord", "Microsoft Teams", "Zoom", "Signal", "Skype",
  "Telegram", "WhatsApp", "FaceTime", "Mail", "Messages",
];
const OFFICE = [
  "Outlook", "Word", "Excel", "PowerPoint", "OneNote",
  // macOS / older Vetroscope builds wrote the full app name without
  // canonicalization. Keep both forms so historical entries categorize.
  "Microsoft Outlook", "Microsoft Word", "Microsoft Excel",
  "Microsoft PowerPoint", "Microsoft OneNote",
  // Apple iWork — bundled, used by many macOS users.
  "Pages", "Numbers", "Keynote",
];
const TERMINAL = [
  "Windows Terminal", "PowerShell", "Command Prompt", "iTerm2", "Terminal",
];
const DESIGN = ["Figma"];
const MEDIA = ["Spotify", "Apple Music", "Music", "VLC"];
const PRODUCTIVITY = [
  "Obsidian", "Notion", "Typora", "Logseq", "Linear", "ClickUp", "TickTick",
  "Todoist", "1Password", "Bitwarden", "Evernote",
];
const SYSTEM = [
  "File Explorer", "Task Manager", "OneDrive", "Snipping Tool", "Management Console",
  "Settings", "Notepad", "Paint", "Calculator", "Registry Editor", "Google Drive",
  "Dropbox", "Finder", "Notes", "Photos", "Microsoft Store", "Phone Link", "Clock",
  "Weather", "Maps", "Voice Recorder", "Media Player", "Xbox",
  // macOS bundled utilities that Vetroscope's tracker records frequently.
  "TextEdit", "App Store", "Activity Monitor", "Archive Utility", "Preview",
  "QuickTime Player", "Disk Utility", "System Settings", "System Preferences",
  "Calendar", "Reminders", "Stocks", "Voice Memos", "Console", "Books",
  "Image Capture", "Font Book", "ColorSync Utility", "Migration Assistant",
];
const VIRTUALIZATION = [
  "Hyper-V", "Windows App", "Remote Desktop", "Remote Desktop Connection",
  "UTM", "Tailscale", "Parallels Desktop", "VMware Fusion", "VirtualBox",
];
const MUSIC_CREATION = [
  "FL Studio", "Audacity", "REAPER", "Ableton Live", "Logic Pro", "Pro Tools",
];
const CREATIVE = [
  "Blender", "DaVinci Resolve", "Unity", "Unity Hub", "Unreal Engine", "Godot",
  "Affinity Designer", "Affinity Photo", "Affinity Publisher", "Krita",
  "Paint.NET", "Inkscape", "GIMP", "Clip Studio Paint", "Clipchamp", "Camtasia",
  "OBS Studio",
  // Screen capture / recording — used heavily for content creation, slots
  // here rather than a single-app "screen_capture" category.
  "Screen Studio", "ScreenFlow", "CleanShot X",
  // Video editing utilities outside the Adobe / Apple suites.
  "LosslessCut", "HandBrake", "Final Cut Pro", "iMovie", "Motion", "Compressor",
];
const LAUNCHER = [
  "Steam", "Epic Games Launcher", "Battle.net", "EA App", "Ubisoft Connect",
  "GOG Galaxy", "Riot Client",
];
const GAMING = [
  "PUBG: BATTLEGROUNDS", "Counter-Strike 2", "Grand Theft Auto V", "Rocket League",
  "Apex Legends", "Fortnite", "Valorant", "Elden Ring", "Baldur's Gate 3",
  "Cyberpunk 2077", "Red Dead Redemption 2", "Hogwarts Legacy", "Satisfactory",
  "Palworld", "Dota 2", "Left 4 Dead 2", "Half-Life 2", "Overwatch 2",
];
const MISC = ["Electron"];

const AI = [
  "Claude", "ChatGPT", "Perplexity", "Gemini", "Grok", "Copilot",
  // macOS app names sometimes include the company prefix.
  "Anthropic Claude", "ChatGPT Desktop",
];

const TIME_TRACKER = [
  "Timing", "Rize", "RescueTime", "Toggl Track", "Clockify",
  "TimeMachine", "Hours", "Tyme",
];

// Jake's own apps — flagging separately so the LLM can spot Vetroscope
// "dogfooding" time vs other dev work.
const FIRST_PARTY = [
  "Vetroscope", "Vetroscope Setup", "Oversight", "Oversight Setup",
];

const buckets: Array<[AppCategory, readonly string[]]> = [
  ["adobe", ADOBE],
  ["editor", EDITOR],
  ["dev_tools", DEV_TOOLS],
  ["browser", BROWSER],
  ["communication", COMMUNICATION],
  ["office", OFFICE],
  ["terminal", TERMINAL],
  ["design", DESIGN],
  ["media", MEDIA],
  ["productivity", PRODUCTIVITY],
  ["system", SYSTEM],
  ["virtualization", VIRTUALIZATION],
  ["music_creation", MUSIC_CREATION],
  ["creative", CREATIVE],
  ["launcher", LAUNCHER],
  ["gaming", GAMING],
  ["ai", AI],
  ["time_tracker", TIME_TRACKER],
  ["first_party", FIRST_PARTY],
  ["misc", MISC],
];

export const APP_CATEGORY: ReadonlyMap<string, AppCategory> = new Map(
  buckets.flatMap(([cat, names]) => names.map((n) => [n, cat] as const))
);

/**
 * Normalize variant app names that the OS / Vetroscope tracker writes with
 * decoration that the canonical map doesn't expect. Specifically:
 *
 *   - Adobe apps frequently arrive as "Adobe Photoshop 2025" or "Adobe
 *     Premiere Pro 2026" depending on Adobe's installer naming. Our
 *     canonical names are unprefixed and unversioned ("Photoshop",
 *     "Premiere Pro"), so we strip both decorations.
 *   - "Adobe XD" is a special case: stripping the prefix would yield
 *     "XD" which isn't in the map. We try the raw name first and only
 *     fall back to the normalized form, so that one is naturally safe.
 *
 * Returns the input unchanged for names that don't match these patterns.
 */
export function normalizeAppName(rawName: string): string {
  let name = rawName.trim();
  if (name.startsWith("Adobe ")) name = name.slice("Adobe ".length).trim();
  // Trailing 4-digit year (Adobe / Autodesk / Microsoft Office annual builds).
  name = name.replace(/\s+(?:19|20)\d{2}$/, "").trim();
  return name;
}

export function categorizeApp(appName: string): AppCategory {
  // Try the raw name first so canonical names with prefixes ("Adobe XD",
  // "Adobe Acrobat") still resolve. Fall back to the normalized form so
  // version-suffixed variants like "Adobe Photoshop 2025" land correctly.
  const direct = APP_CATEGORY.get(appName);
  if (direct) return direct;
  const normalized = normalizeAppName(appName);
  if (normalized !== appName) {
    const viaNorm = APP_CATEGORY.get(normalized);
    if (viaNorm) return viaNorm;
  }
  return "uncategorized";
}
