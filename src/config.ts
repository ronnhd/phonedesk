import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { ICON_ALIASES } from "../web/shared/icons";
import { macroSteps, pushOptions, validateRules, weatherOptions, type MacroStep, type PushOptions, type Rule, type WeatherOptions } from "./automation";
export type { MacroStep, PushOptions, Rule, WeatherOptions } from "./automation";

export type Action =
  | { type: "open"; target: string }
  | { type: "hotkey"; keys: string }
  | { type: "type"; text: string }
  | { type: "shell"; command: string }
  | { type: "media"; command: "playpause" | "next" | "previous" }
  | { type: "volume"; command: "up" | "down" | "mute" }
  | { type: "page"; page: string }
  /** Soundboard: play an uploaded clip (~/.phonedesk/sounds/<id>.<ext>) on the Mac (afplay), the phone, or both. */
  | { type: "sound"; sound: string; on?: SoundTarget; volume?: number; mode?: SoundMode }
  | { type: "sound-stop" }
  /** Home Assistant service call through the agent's HA connection, e.g. {service:"scene.turn_on", entityId:"scene.movie"}. */
  | { type: "hass"; service: string; entityId?: string; data?: Record<string, unknown> }
  /** Several steps in order (keys, text, waits, other buttons, HA calls…), see src/automation.ts. */
  | { type: "macro"; steps: MacroStep[] };

export const HASS_ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
export const HASS_SERVICE_RE = /^[a-z_]+\.[a-z0-9_]+$/;

/** Home Assistant entity tile: live state; tapping toggles/activates it when the domain allows (unless readOnly). */
export interface EntityOptions {
  id: string;            // entity_id, e.g. "light.living_room"
  name?: string;         // display name override
  readOnly?: boolean;    // show state only
  show?: "auto" | "state" | "value" | "toggle"; // auto: toggle for switchable domains, value for sensors
  /** What a tap does for climate/light/fan/cover/vacuum: open the control sheet (default) or just toggle. */
  tap?: "sheet" | "toggle";
  /** Show -/+ or a slider on the tile itself when it is big enough (default true). */
  inlineControls?: boolean;
}

export type SoundTarget = "mac" | "phone" | "both";
export type SoundMode = "overlap" | "restart" | "toggle";
export const SOUND_ID_RE = /^snd:[a-f0-9]{16}$/;

/** nowplaying = current track + transport + volume (agent sends {type:"media"}); network = rx/tx rates. */
export type WidgetKind = "clock" | "cpu" | "memory" | "uptime" | "load" | "network" | "nowplaying" | "quota" | "sessions" | "entity" | "weather" | "value" | "notifications" | "polymarket";

/** AI coding tools PhoneDesk reads quotas/sessions from. A "quota" widget shows one provider (item.provider). */
export type AiProvider = "omni" | "claude" | "codex" | "antigravity" | "opencode" | "grok";
export const AI_PROVIDERS: AiProvider[] = ["omni", "claude", "codex", "antigravity", "opencode", "grok"];

/**
 * Tile placement on the page grid: x/y = top-left cell (0-based), w/h = span in cells (default 1x1).
 * validateLayout always returns x and y (it auto-places items that have none, in order).
 */
export interface Size { x?: number; y?: number; w?: number; h?: number }

/** How a coloured tile is painted: tint = soft fill + coloured border/icon, solid = full fill, outline = border + icon only. */
/** ios = Shortcuts-style button: coloured squircle with a vertical gradient, white glyph, label under the tile. */
export type TileStyle = "tint" | "solid" | "outline" | "ios";
export const TILE_STYLES: TileStyle[] = ["tint", "solid", "outline", "ios"];

/** Per-tile look overrides. Unset fields fall back to the theme. */
export interface ItemStyle {
  style?: TileStyle;
  textColor?: string;   // label/value colour
  hideLabel?: boolean;  // icon only (buttons) / value only (widgets)
}

export type Item =
  | ({ id: string; kind: "button"; label: string; icon?: string; color?: string; action?: Action } & Size & ItemStyle)
  | ({ id: string; kind: "widget"; widget: WidgetKind; color?: string; provider?: AiProvider; clock?: ClockOptions; metric?: MetricOptions; quota?: QuotaOptions; entity?: EntityOptions; weather?: WeatherOptions; push?: PushOptions } & Size & ItemStyle);

/**
 * Quota widget looks. auto (default) picks by tile width: ring on small tiles, bars when wide, meter when wide and tall.
 * bars = one horizontal bar per window, rings = concentric rings (Knowns goal-rings), gauge = arc of the main window,
 * meter = Knowns usage-meter card, number = percentage only, history = usage over the last hours (sparkline per window).
 */
export type QuotaChart = "auto" | "bars" | "rings" | "gauge" | "meter" | "number" | "history";
export const QUOTA_CHARTS: QuotaChart[] = ["auto", "bars", "rings", "gauge", "meter", "number", "history"];
export interface QuotaOptions {
  chart?: QuotaChart;
  /**
   * Which usage windows to show: "all", "main" (5 h for Claude), or a list of window ids in display order
   * (ids as the agent reports them, e.g. "five_hour", "seven_day", "seven_day_opus", "primary", "secondary").
   * Unknown ids are skipped at render time (a provider may not have that window today).
   */
  windows?: "all" | "main" | string[];
  showReset?: boolean;       // reset countdown, default true
  account?: string;          // pin one account id when the provider has several
}

/**
 * How a metric widget (cpu, memory, network, load) is drawn. Every chart comes from the Knowns UI chart family.
 * sparkline = line + end dot, area = filled sparkline, bars = column history, gauge = 0-100 arc,
 * ring = progress ring, bar = one horizontal meter, number = value only, donut = used/free split (memory).
 */
export type MetricChart = "sparkline" | "area" | "bars" | "gauge" | "ring" | "bar" | "number" | "donut";
export const METRIC_CHARTS: MetricChart[] = ["sparkline", "area", "bars", "gauge", "ring", "bar", "number", "donut"];
export const METRIC_WIDGETS = ["cpu", "memory", "network", "load"] as const;
/** Charts that need a 0-100 scale are not offered for network/load (they have no fixed maximum). */
export const METRIC_CHARTS_FOR: Record<(typeof METRIC_WIDGETS)[number], MetricChart[]> = {
  cpu: ["sparkline", "area", "bars", "gauge", "ring", "bar", "number"],
  memory: ["sparkline", "area", "bars", "gauge", "ring", "bar", "number", "donut"],
  network: ["sparkline", "area", "bars", "number"],
  load: ["sparkline", "area", "bars", "number"],
};
export const METRIC_WINDOWS = [60, 300, 900] as const; // seconds of history: 1, 5, 15 min

export interface MetricOptions {
  chart?: MetricChart;       // default: cpu gauge on square-ish tiles else sparkline; memory/network/load sparkline
  window?: 60 | 300 | 900;   // history shown by sparkline/area/bars, default 120 s worth of 2 s samples
  showDelta?: boolean;       // the change pill, default true
  showSub?: boolean;         // the secondary line ("/ 16 GB", "↑ tx"), default true when it fits
}

/**
 * Clock widget looks. digital = big thin digits (default), flip = split-flap cards, analog = dial with hands,
 * minimal = time only, word = the time written out in words ("ten to five", or in Vietnamese "mười giờ kém năm"), world = several time zones.
 */
export type ClockStyle = "digital" | "flip" | "analog" | "minimal" | "word" | "world";
export const CLOCK_STYLES: ClockStyle[] = ["digital", "flip", "analog", "minimal", "word", "world"];

export interface ClockOptions {
  style?: ClockStyle;      // default "digital"
  seconds?: boolean;       // default true on big tiles
  hour12?: boolean;        // default false (24 h)
  showDate?: boolean;      // default true on big tiles
  timeZone?: string;       // IANA name, default the phone's zone (world: the first zone)
  zones?: string[];        // world style: up to 4 extra IANA zones
  label?: string;          // optional caption, e.g. "Tokyo"
}

/** Overrides of the deck's design tokens (Knowns look). Unset fields use the built-in token values. */
export interface Theme {
  mode?: "dark" | "light" | "auto"; // default "dark"
  accent?: string;      // CSS color, default "#22d3ee" (brand cyan; green is only the live/connected status colour)
  background?: string;  // CSS color (--bg), default "#0b0b0d"
  tile?: string;        // tile background (--surface), default "#141417"
  radius?: number;      // px, 0-40, default 14
  gap?: number;         // px, 0-40, default 10
  fontScale?: number;   // 0.5-2, default 1
  tileStyle?: TileStyle; // default "tint"
  iconScale?: number;   // 0.5-2, default 1
  iconStroke?: number;  // outline icon stroke width on a 24px grid, 1-3, default 2.25 ("bold")
  showLabels?: boolean; // default true
  text?: string;        // main text colour (--text)
  /**
   * landscape (default): the grid is laid out for a phone held sideways; when the phone is upright the deck
   * rotates 90deg to fill the screen. portrait: the reverse. auto: follow the phone, no rotation.
   */
  orientation?: Orientation;
  /** UI language for the phone overlay and the management page. English is the default; Vietnamese is the extra one. */
  language?: Language;
  /** Temperature unit for every widget (weather, climate, sensors); missing = "c". A widget-level weather.units still wins. */
  temperatureUnit?: "c" | "f";
  /** false = never ask GitHub whether a newer PhoneDesk exists (GET /api/update then reports enabled:false). Missing = on. */
  updateCheck?: boolean;
}

export type Orientation = "landscape" | "portrait" | "auto";
export const ORIENTATIONS: Orientation[] = ["landscape", "portrait", "auto"];
export const LANGUAGES = ["en", "vi"] as const;
export type Language = (typeof LANGUAGES)[number];

/** A fixed Stream Deck-style grid of square cells: columns x rows. */
export interface Page {
  id: string;
  name: string;
  columns: number; // 1-12
  rows: number;    // 1-8
  items: Item[];
}

export const MAX_COLUMNS = 12;
export const MAX_ROWS = 8;

export interface Layout {
  version: 1;
  theme?: Theme;
  pages: Page[];
  /** Automation rules: see src/automation.ts. */
  rules?: Rule[];
}

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeen?: string;
  /** lastSeen (or createdAt) + 365 days; a token unused for a year stops working. Refreshed on every connect. */
  expiresAt?: string;
}

export const HOME = process.env.PHONEDESK_HOME ?? join(homedir(), ".phonedesk");
const LAYOUT_FILE = join(HOME, "layout.json");
const DEVICES_FILE = join(HOME, "devices.json");

export const ACTION_TYPES = ["open", "hotkey", "type", "shell", "media", "volume", "page", "sound", "sound-stop", "hass", "macro"] as const;
export const WIDGET_KINDS: WidgetKind[] = ["clock", "cpu", "memory", "uptime", "load", "network", "nowplaying", "quota", "sessions", "entity", "weather", "value", "notifications", "polymarket"];

export function defaultLayout(): Layout {
  return {
    version: 1,
    theme: { mode: "dark", orientation: "landscape", tileStyle: "ios", iconStroke: 2.25 },
    pages: [
      {
        // Dashboard: big clock + now playing on top, four metric tiles below.
        id: "overview",
        name: "Overview",
        columns: 8,
        rows: 3,
        items: [
          { id: "w-clock", kind: "widget", widget: "clock", x: 0, y: 0, w: 4, h: 2 },
          { id: "w-media", kind: "widget", widget: "nowplaying", x: 4, y: 0, w: 4, h: 2 },
          { id: "w-cpu", kind: "widget", widget: "cpu", color: "#2dd4bf", x: 0, y: 2, w: 2 },
          { id: "w-mem", kind: "widget", widget: "memory", color: "#22d3ee", x: 2, y: 2, w: 2 },
          { id: "w-net", kind: "widget", widget: "network", color: "#f59e0b", x: 4, y: 2, w: 2 },
          { id: "w-load", kind: "widget", widget: "load", color: "#60a5fa", metric: { chart: "bars" }, x: 6, y: 2, w: 2 },
        ],
      },
      {
        id: "ai",
        name: "AI",
        columns: 8,
        rows: 3,
        items: [
          { id: "w-q-claude", kind: "widget", widget: "quota", provider: "claude", color: "#d97757", x: 0, y: 0, w: 2, h: 2 },
          { id: "w-q-codex", kind: "widget", widget: "quota", provider: "codex", color: "#e5e7eb", x: 2, y: 0, w: 2, h: 2 },
          { id: "w-q-agy", kind: "widget", widget: "quota", provider: "antigravity", color: "#60a5fa", x: 4, y: 0, w: 2, h: 2 },
          { id: "w-sessions", kind: "widget", widget: "sessions", x: 6, y: 0, w: 2, h: 3 },
          { id: "w-cpu-ai", kind: "widget", widget: "cpu", color: "#2dd4bf", x: 0, y: 2, w: 2 },
          { id: "w-mem-ai", kind: "widget", widget: "memory", color: "#22d3ee", x: 2, y: 2, w: 2 },
          { id: "w-clock-ai", kind: "widget", widget: "clock", clock: { style: "world", zones: ["America/Los_Angeles", "Europe/London"] }, x: 4, y: 2, w: 2 },
        ],
      },
      {
        id: "home",
        name: "Keys",
        columns: 8,
        rows: 3,
        items: [
          // row 0: media
          { id: "w-clock2", kind: "widget", widget: "clock", clock: { style: "flip" }, x: 0, y: 0, w: 2 },
          { id: "w-cpu2", kind: "widget", widget: "cpu", x: 2, y: 0 },
          { id: "w-mem2", kind: "widget", widget: "memory", metric: { chart: "ring" }, x: 3, y: 0 },
          { id: "b-prev", kind: "button", label: "Previous", icon: "player-skip-back", x: 4, y: 0, action: { type: "media", command: "previous" } },
          { id: "b-play", kind: "button", label: "Play / Pause", icon: "player-play", color: "#22d3ee", x: 5, y: 0, action: { type: "media", command: "playpause" } },
          { id: "b-next", kind: "button", label: "Next", icon: "player-skip-forward", x: 6, y: 0, action: { type: "media", command: "next" } },
          { id: "b-mute", kind: "button", label: "Mute", icon: "volume-3", x: 7, y: 0, action: { type: "volume", command: "mute" } },
          // row 1: apps + volume
          { id: "b-web", kind: "button", label: "GitHub", icon: "brand-github", x: 0, y: 1, action: { type: "open", target: "https://github.com" } },
          { id: "b-term", kind: "button", label: "Terminal", icon: "terminal-2", x: 1, y: 1, action: { type: "open", target: "Terminal" } },
          { id: "b-copy", kind: "button", label: "Copy", icon: "copy", x: 2, y: 1, action: { type: "hotkey", keys: "cmd+c" } },
          { id: "b-paste", kind: "button", label: "Paste", icon: "clipboard", x: 3, y: 1, action: { type: "hotkey", keys: "cmd+v" } },
          { id: "b-voldn", kind: "button", label: "Volume down", icon: "volume-2", x: 6, y: 1, action: { type: "volume", command: "down" } },
          { id: "b-volup", kind: "button", label: "Volume up", icon: "volume", x: 7, y: 1, action: { type: "volume", command: "up" } },
          // row 2
          { id: "b-shot", kind: "button", label: "Screenshot", icon: "camera", x: 0, y: 2, action: { type: "hotkey", keys: "cmd+shift+4" } },
          { id: "b-dev", kind: "button", label: "Tools", icon: "layout-grid", color: "#38bdf8", x: 7, y: 2, action: { type: "page", page: "dev" } },
        ],
      },
      {
        id: "dev",
        name: "Tools",
        columns: 8,
        rows: 2,
        items: [
          { id: "w-load", kind: "widget", widget: "load", x: 0, y: 0, w: 2 },
          { id: "w-up", kind: "widget", widget: "uptime", x: 2, y: 0, w: 2 },
          { id: "b-undo", kind: "button", label: "Undo", icon: "arrow-back-up", x: 4, y: 0, action: { type: "hotkey", keys: "cmd+z" } },
          { id: "b-redo", kind: "button", label: "Redo", icon: "arrow-forward-up", x: 5, y: 0, action: { type: "hotkey", keys: "cmd+shift+z" } },
          { id: "b-save", kind: "button", label: "Save", icon: "device-floppy", x: 6, y: 0, action: { type: "hotkey", keys: "cmd+s" } },
          { id: "b-find", kind: "button", label: "Find", icon: "search", x: 7, y: 0, action: { type: "hotkey", keys: "cmd+f" } },
          { id: "b-lock", kind: "button", label: "Lock", icon: "lock", x: 0, y: 1, action: { type: "hotkey", keys: "ctrl+cmd+q" } },
          { id: "b-home", kind: "button", label: "Home", icon: "home", color: "#38bdf8", x: 7, y: 1, action: { type: "page", page: "home" } },
        ],
      },
    ],
  };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${err?.message ?? err}`);
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export async function loadLayout(): Promise<Layout> {
  const raw = await readJson<unknown>(LAYOUT_FILE);
  if (raw === undefined) {
    const layout = defaultLayout();
    await writeJson(LAYOUT_FILE, layout);
    return layout;
  }
  return validateLayout(raw);
}

export async function saveLayout(layout: Layout): Promise<void> {
  await writeJson(LAYOUT_FILE, layout);
}

export async function loadDevices(): Promise<Device[]> {
  return (await readJson<Device[]>(DEVICES_FILE)) ?? [];
}

export async function saveDevices(devices: Device[]): Promise<void> {
  await writeJson(DEVICES_FILE, devices);
}

const num = (v: unknown, field: string, min: number, max: number, int = true): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${field} must be ${int ? "an integer " : ""}between ${min} and ${max}`);
  return n;
};

const optColor = (v: unknown, field: string): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const c = str(v, field);
  // Rendered into CSS: allow only plain color syntaxes.
  if (!/^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-zA-Z]{3,20})$/.test(c)) throw new Error(`${field} is not a valid color`);
  return c;
};

function validateTheme(t: any): Theme | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t !== "object") throw new Error("theme must be an object");
  const out: Theme = {};
  if (t.mode !== undefined) {
    if (!["dark", "light", "auto"].includes(t.mode)) throw new Error('theme.mode must be "dark", "light" or "auto"');
    out.mode = t.mode;
  }
  const accent = optColor(t.accent, "theme.accent"); if (accent) out.accent = accent;
  const background = optColor(t.background, "theme.background"); if (background) out.background = background;
  const tile = optColor(t.tile, "theme.tile"); if (tile) out.tile = tile;
  if (t.radius !== undefined) out.radius = num(t.radius, "theme.radius", 0, 40);
  if (t.gap !== undefined) out.gap = num(t.gap, "theme.gap", 0, 40);
  if (t.fontScale !== undefined) out.fontScale = num(t.fontScale, "theme.fontScale", 0.5, 2, false);
  if (t.tileStyle !== undefined) out.tileStyle = tileStyle(t.tileStyle, "theme.tileStyle");
  if (t.iconScale !== undefined) out.iconScale = num(t.iconScale, "theme.iconScale", 0.5, 2, false);
  if (t.iconStroke !== undefined) out.iconStroke = num(t.iconStroke, "theme.iconStroke", 1, 3, false);
  if (t.showLabels !== undefined) out.showLabels = bool(t.showLabels, "theme.showLabels");
  const text = optColor(t.text, "theme.text"); if (text) out.text = text;
  if (t.temperatureUnit !== undefined) {
    if (t.temperatureUnit !== "c" && t.temperatureUnit !== "f") throw new Error("theme.temperatureUnit must be c or f");
    out.temperatureUnit = t.temperatureUnit;
  }
  if (t.updateCheck !== undefined) out.updateCheck = bool(t.updateCheck, "theme.updateCheck");
  if (t.language !== undefined) {
    if (!LANGUAGES.includes(t.language)) throw new Error(`theme.language must be one of ${LANGUAGES.join(", ")}`);
    out.language = t.language;
  }
  if (t.orientation !== undefined) {
    if (!ORIENTATIONS.includes(t.orientation)) throw new Error(`theme.orientation must be one of ${ORIENTATIONS.join(", ")}`);
    out.orientation = t.orientation;
  }
  return out;
}

/**
 * Places items on a columns x rows grid. Items with x/y keep their cell (checked for bounds and overlap);
 * items without are put in the first free cell, row by row, in list order. When `rows` is undefined
 * (legacy layouts saved before fixed grids) the grid grows to fit and the resulting row count is returned.
 */
export function placeItems(items: Item[], columns: number, rows: number | undefined, where: string): { items: Item[]; rows: number } {
  const limit = rows ?? MAX_ROWS;
  const taken: (string | undefined)[][] = Array.from({ length: limit }, () => new Array(columns).fill(undefined));
  const fits = (x: number, y: number, w: number, h: number) => {
    if (x < 0 || y < 0 || x + w > columns || y + h > limit) return false;
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (taken[r][c]) return false;
    return true;
  };
  const mark = (id: string, x: number, y: number, w: number, h: number) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) taken[r][c] = id;
  };
  const out = items.map((it) => ({ ...it }));
  // Fixed positions first, so auto-placed items flow around them.
  for (const it of out) {
    if (it.x === undefined || it.y === undefined) continue;
    const w = it.w ?? 1, h = it.h ?? 1;
    if (it.x + w > columns || it.y + h > limit) throw new Error(`${where}: item "${it.id}" does not fit in the ${columns}x${limit} grid`);
    if (!fits(it.x, it.y, w, h)) {
      const other = taken[it.y][it.x] ?? "another item";
      throw new Error(`${where}: item "${it.id}" overlaps "${other}"`);
    }
    mark(it.id, it.x, it.y, w, h);
  }
  for (const it of out) {
    if (it.x !== undefined && it.y !== undefined) continue;
    const w = it.w ?? 1, h = it.h ?? 1;
    let placed = false;
    for (let y = 0; y < limit && !placed; y++) for (let x = 0; x < columns && !placed; x++) {
      if (fits(x, y, w, h)) { it.x = x; it.y = y; mark(it.id, x, y, w, h); placed = true; }
    }
    if (!placed) throw new Error(`${where}: no free space for item "${it.id}" in the ${columns}x${limit} grid`);
  }
  const used = out.reduce((m, it) => Math.max(m, (it.y ?? 0) + (it.h ?? 1)), 1);
  return { items: out, rows: rows ?? used };
}

function tileStyle(v: unknown, field: string): TileStyle {
  if (!TILE_STYLES.includes(v as TileStyle)) throw new Error(`${field} must be one of ${TILE_STYLES.join(", ")}`);
  return v as TileStyle;
}

const isZone = (z: string) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } };

function clockOptions(c: any, where: string): ClockOptions | undefined {
  if (c === undefined || c === null) return undefined;
  if (typeof c !== "object" || Array.isArray(c)) throw new Error(`${where} must be an object`);
  const out: ClockOptions = {};
  if (c.style !== undefined) {
    if (!CLOCK_STYLES.includes(c.style)) throw new Error(`${where}.style must be one of ${CLOCK_STYLES.join(", ")}`);
    out.style = c.style;
  }
  for (const k of ["seconds", "hour12", "showDate"] as const) if (c[k] !== undefined) out[k] = bool(c[k], `${where}.${k}`);
  if (c.timeZone !== undefined && c.timeZone !== "") {
    const z = str(c.timeZone, `${where}.timeZone`);
    if (!isZone(z)) throw new Error(`${where}.timeZone "${z}" is not a known time zone`);
    out.timeZone = z;
  }
  if (c.zones !== undefined) {
    if (!Array.isArray(c.zones) || c.zones.length > 4) throw new Error(`${where}.zones must be a list of up to 4 time zones`);
    out.zones = c.zones.map((z: unknown, i: number) => {
      const v = str(z, `${where}.zones[${i}]`);
      if (!isZone(v)) throw new Error(`${where}.zones[${i}] "${v}" is not a known time zone`);
      return v;
    });
  }
  if (c.label !== undefined && c.label !== "") out.label = str(c.label, `${where}.label`).slice(0, 40);
  return Object.keys(out).length ? out : undefined;
}

function quotaOptions(q: any, where: string): QuotaOptions | undefined {
  if (q === undefined || q === null) return undefined;
  if (typeof q !== "object" || Array.isArray(q)) throw new Error(`${where} must be an object`);
  const out: QuotaOptions = {};
  if (q.chart !== undefined) {
    if (!QUOTA_CHARTS.includes(q.chart)) throw new Error(`${where}.chart must be one of ${QUOTA_CHARTS.join(", ")}`);
    out.chart = q.chart;
  }
  if (q.windows !== undefined) {
    if (Array.isArray(q.windows)) {
      if (q.windows.length < 1 || q.windows.length > 6) throw new Error(`${where}.windows must list 1-6 window ids`);
      for (const w of q.windows) if (typeof w !== "string" || !/^[a-z0-9_.:-]{1,48}$/i.test(w)) throw new Error(`${where}.windows has an invalid window id`);
      out.windows = [...new Set(q.windows as string[])];
    } else {
      if (q.windows !== "all" && q.windows !== "main") throw new Error(`${where}.windows must be "all", "main" or a list of window ids`);
      out.windows = q.windows;
    }
  }
  if (q.showReset !== undefined) out.showReset = bool(q.showReset, `${where}.showReset`);
  if (q.account !== undefined && q.account !== "") out.account = str(q.account, `${where}.account`).slice(0, 80);
  return Object.keys(out).length ? out : undefined;
}

function metricOptions(m: any, widget: string, where: string): MetricOptions | undefined {
  if (m === undefined || m === null) return undefined;
  if (typeof m !== "object" || Array.isArray(m)) throw new Error(`${where} must be an object`);
  const out: MetricOptions = {};
  if (m.chart !== undefined) {
    const allowed = METRIC_CHARTS_FOR[widget as (typeof METRIC_WIDGETS)[number]];
    if (!allowed.includes(m.chart)) throw new Error(`${where}.chart for ${widget} must be one of ${allowed.join(", ")}`);
    out.chart = m.chart;
  }
  if (m.window !== undefined) {
    if (!(METRIC_WINDOWS as readonly number[]).includes(m.window)) throw new Error(`${where}.window must be one of ${METRIC_WINDOWS.join(", ")} seconds`);
    out.window = m.window;
  }
  if (m.showDelta !== undefined) out.showDelta = bool(m.showDelta, `${where}.showDelta`);
  if (m.showSub !== undefined) out.showSub = bool(m.showSub, `${where}.showSub`);
  return Object.keys(out).length ? out : undefined;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${field} must be true or false`);
  return v;
}

function itemStyle(it: any, w: string): ItemStyle {
  const out: ItemStyle = {};
  if (it.style !== undefined && it.style !== null && it.style !== "") out.style = tileStyle(it.style, `${w}.style`);
  const textColor = optColor(it.textColor, `${w}.textColor`); if (textColor) out.textColor = textColor;
  if (it.hideLabel !== undefined && it.hideLabel !== null) { const h = bool(it.hideLabel, `${w}.hideLabel`); if (h) out.hideLabel = true; }
  return out;
}

/** Layouts saved before the Lucide/Reicon -> Tabler switch use old names: store the new one. */
/**
 * An item's icon is one of:
 *   - a Tabler icon name (built-in set in web/shared/icons.ts, or any of the full catalog web/shared/icon-catalog.json),
 *   - a brand mark name (BRANDS), an old Lucide name (ICON_ALIASES, renamed here),
 *   - "app:<bundleId>"   the icon of an installed Mac app (the agent extracts it),
 *   - "lobe:<name>"      any LobeHub brand mark (web/shared/icon-catalog.json brands),
 *   - "img:<16 hex id>"  an image the owner uploaded (~/.phonedesk/icons/<id>.png),
 *   - any short text or emoji (max 8 characters / 4 graphemes is the UI's limit; the schema allows 64).
 */
export const APP_ICON_RE = /^app:[A-Za-z0-9][A-Za-z0-9.\-]{0,127}$/;
export const IMG_ICON_RE = /^img:[a-f0-9]{16}$/;
/** Any LobeHub brand mark from web/shared/icon-catalog.json "brands" (AI providers, models, apps). */
export const LOBE_ICON_RE = /^lobe:[a-z0-9][a-z0-9.-]{0,63}$/;

/** Layouts saved before the Lucide/Reicon -> Tabler switch use old names: store the new one. Also checks app:/img: forms. */
function normalizeIcon(v: string, where = "icon"): string {
  if (v.length > 140) throw new Error(`${where} is too long`);
  if (v.startsWith("app:") && !APP_ICON_RE.test(v)) throw new Error(`${where} "${v}" is not a valid app icon (app:<bundle id>)`);
  if (v.startsWith("lobe:") && !LOBE_ICON_RE.test(v)) throw new Error(`${where} "${v}" is not a valid brand icon (lobe:<name>)`);
  if (v.startsWith("img:") && !IMG_ICON_RE.test(v)) throw new Error(`${where} "${v}" is not a valid image icon`);
  return Object.prototype.hasOwnProperty.call(ICON_ALIASES, v) ? ICON_ALIASES[v]! : v;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  return v;
}

function validateAction(a: any, where: string): Action {
  if (!a || typeof a !== "object") throw new Error(`${where}.action must be an object`);
  switch (a.type) {
    case "open": return { type: "open", target: str(a.target, `${where}.action.target`) };
    case "hotkey": return { type: "hotkey", keys: str(a.keys, `${where}.action.keys`) };
    case "type": return { type: "type", text: str(a.text, `${where}.action.text`) };
    case "shell": return { type: "shell", command: str(a.command, `${where}.action.command`) };
    case "page": return { type: "page", page: str(a.page, `${where}.action.page`) };
    case "sound": {
      const sound = str(a.sound, `${where}.action.sound`);
      if (!SOUND_ID_RE.test(sound)) throw new Error(`${where}.action.sound must be an uploaded sound (snd:<id>)`);
      const out: Action = { type: "sound", sound };
      if (a.on !== undefined) { if (!["mac", "phone", "both"].includes(a.on)) throw new Error(`${where}.action.on must be mac, phone or both`); (out as any).on = a.on; }
      if (a.volume !== undefined) (out as any).volume = num(a.volume, `${where}.action.volume`, 0, 100);
      if (a.mode !== undefined) { if (!["overlap", "restart", "toggle"].includes(a.mode)) throw new Error(`${where}.action.mode must be overlap, restart or toggle`); (out as any).mode = a.mode; }
      return out;
    }
    case "sound-stop": return { type: "sound-stop" };
    case "macro": return { type: "macro", steps: macroSteps(a.steps, `${where}.action.steps`) };
    case "hass": {
      const service = str(a.service, `${where}.action.service`);
      if (!HASS_SERVICE_RE.test(service)) throw new Error(`${where}.action.service must look like "domain.service"`);
      const out: any = { type: "hass", service };
      if (a.entityId !== undefined && a.entityId !== "") {
        const e = str(a.entityId, `${where}.action.entityId`);
        if (!HASS_ENTITY_RE.test(e)) throw new Error(`${where}.action.entityId must look like "domain.object_id"`);
        out.entityId = e;
      }
      if (a.data !== undefined && a.data !== null) {
        if (typeof a.data !== "object" || Array.isArray(a.data)) throw new Error(`${where}.action.data must be an object`);
        if (JSON.stringify(a.data).length > 2048) throw new Error(`${where}.action.data is too large`);
        out.data = a.data;
      }
      return out;
    }
    case "media":
      if (!["playpause", "next", "previous"].includes(a.command)) throw new Error(`${where}.action.command is invalid`);
      return { type: "media", command: a.command };
    case "volume":
      if (!["up", "down", "mute"].includes(a.command)) throw new Error(`${where}.action.command is invalid`);
      return { type: "volume", command: a.command };
    default:
      throw new Error(`${where}.action.type "${a.type}" is not supported`);
  }
}

/** Validates untrusted layout JSON and returns a normalized copy. Throws with a readable message. */
export function validateLayout(raw: any): Layout {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.pages)) throw new Error("layout.pages must be an array");
  if (raw.pages.length === 0) throw new Error("layout needs at least one page");
  const pageIds = new Set<string>();
  const pages: Page[] = raw.pages.map((p: any, pi: number) => {
    const where = `pages[${pi}]`;
    const id = str(p?.id, `${where}.id`);
    if (pageIds.has(id)) throw new Error(`duplicate page id "${id}"`);
    pageIds.add(id);
    const columns = Number(p.columns ?? 4);
    if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS) throw new Error(`${where}.columns must be 1-${MAX_COLUMNS}`);
    const rows = p.rows === undefined || p.rows === null ? undefined : num(p.rows, `${where}.rows`, 1, MAX_ROWS);
    if (!Array.isArray(p.items)) throw new Error(`${where}.items must be an array`);
    const itemIds = new Set<string>();
    const items: Item[] = p.items.map((it: any, ii: number) => {
      const w = `${where}.items[${ii}]`;
      const itemId = str(it?.id, `${w}.id`);
      if (itemIds.has(itemId)) throw new Error(`duplicate item id "${itemId}" on page "${id}"`);
      itemIds.add(itemId);
      const color = optColor(it.color, `${w}.color`);
      const size: Size = {};
      if (it.w !== undefined && it.w !== null) size.w = num(it.w, `${w}.w`, 1, columns);
      if (it.h !== undefined && it.h !== null) size.h = num(it.h, `${w}.h`, 1, MAX_ROWS);
      const hasX = it.x !== undefined && it.x !== null, hasY = it.y !== undefined && it.y !== null;
      if (hasX !== hasY) throw new Error(`${w} needs both x and y, or neither`);
      if (hasX) { size.x = num(it.x, `${w}.x`, 0, columns - 1); size.y = num(it.y, `${w}.y`, 0, MAX_ROWS - 1); }
      if (it.kind === "widget") {
        if (!WIDGET_KINDS.includes(it.widget)) throw new Error(`${w}.widget "${it.widget}" is not supported`);
        let provider: AiProvider | undefined;
        if (it.provider !== undefined && it.provider !== null && it.provider !== "") {
          if (!AI_PROVIDERS.includes(it.provider)) throw new Error(`${w}.provider must be one of ${AI_PROVIDERS.join(", ")}`);
          provider = it.provider;
        }
        if (it.widget === "quota" && !provider) throw new Error(`${w}: a quota widget needs a provider`);
        const clock = it.widget === "clock" ? clockOptions(it.clock, `${w}.clock`) : undefined;
        const metric = (METRIC_WIDGETS as readonly string[]).includes(it.widget) ? metricOptions(it.metric, it.widget, `${w}.metric`) : undefined;
        const quota = it.widget === "quota" ? quotaOptions(it.quota, `${w}.quota`) : undefined;
        const weather = it.widget === "weather" ? weatherOptions(it.weather, `${w}.weather`) : undefined;
        const push = (it.widget === "value" || it.widget === "polymarket") ? pushOptions(it.push, `${w}.push`) : undefined;
        let entity: EntityOptions | undefined;
        if (it.widget === "entity") {
          const e = it.entity;
          if (!e || typeof e !== "object") throw new Error(`${w}: an entity widget needs entity.id`);
          const id = str(e.id, `${w}.entity.id`);
          if (!HASS_ENTITY_RE.test(id)) throw new Error(`${w}.entity.id must look like "domain.object_id"`);
          entity = { id };
          if (e.name !== undefined && e.name !== "") entity.name = str(e.name, `${w}.entity.name`).slice(0, 60);
          if (e.readOnly !== undefined) entity.readOnly = bool(e.readOnly, `${w}.entity.readOnly`);
          if (e.tap !== undefined) { if (e.tap !== "sheet" && e.tap !== "toggle") throw new Error(`${w}.entity.tap must be sheet or toggle`); entity.tap = e.tap; }
          if (e.inlineControls !== undefined) entity.inlineControls = bool(e.inlineControls, `${w}.entity.inlineControls`);
          if (e.show !== undefined) { if (!["auto", "state", "value", "toggle"].includes(e.show)) throw new Error(`${w}.entity.show is invalid`); entity.show = e.show; }
        }
        return { id: itemId, kind: "widget", widget: it.widget, color, ...(provider ? { provider } : {}), ...(clock ? { clock } : {}), ...(metric ? { metric } : {}), ...(quota ? { quota } : {}), ...(entity ? { entity } : {}), ...(weather ? { weather } : {}), ...(push ? { push } : {}), ...size, ...itemStyle(it, w) };
      }
      if (it.kind === "button") {
        return {
          id: itemId,
          kind: "button",
          label: str(it.label ?? "", `${w}.label`),
          icon: it.icon === undefined || it.icon === "" ? undefined : normalizeIcon(str(it.icon, `${w}.icon`), `${w}.icon`),
          color,
          action: it.action === undefined || it.action === null ? undefined : validateAction(it.action, w),
          ...size,
          ...itemStyle(it, w),
        };
      }
      throw new Error(`${w}.kind must be "button" or "widget"`);
    });
    const placed = placeItems(items, columns, rows, `page "${id}"`);
    return { id, name: str(p.name ?? id, `${where}.name`), columns, rows: placed.rows, items: placed.items };
  });
  const theme = validateTheme(raw.theme);
  const rules = validateRules(raw.rules, new Set(pages.map((p) => p.id)));
  return { version: 1, ...(theme ? { theme } : {}), pages, ...(rules ? { rules } : {}) };
}
