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
const OFFICE = ["Outlook", "Word", "Excel", "PowerPoint", "OneNote"];
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
];
const VIRTUALIZATION = ["Hyper-V", "Windows App", "Remote Desktop"];
const MUSIC_CREATION = [
  "FL Studio", "Audacity", "REAPER", "Ableton Live", "Logic Pro", "Pro Tools",
];
const CREATIVE = [
  "Blender", "DaVinci Resolve", "Unity", "Unity Hub", "Unreal Engine", "Godot",
  "Affinity Designer", "Affinity Photo", "Affinity Publisher", "Krita",
  "Paint.NET", "Inkscape", "GIMP", "Clip Studio Paint", "Clipchamp", "Camtasia",
  "OBS Studio",
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
  ["misc", MISC],
];

export const APP_CATEGORY: ReadonlyMap<string, AppCategory> = new Map(
  buckets.flatMap(([cat, names]) => names.map((n) => [n, cat] as const))
);

export function categorizeApp(appName: string): AppCategory {
  return APP_CATEGORY.get(appName) ?? "uncategorized";
}
