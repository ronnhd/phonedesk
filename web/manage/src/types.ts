// Mirrors src/config.ts of the agent (that file imports node modules, so the types are duplicated here).
export type Action =
  | { type: "open"; target: string }
  | { type: "hotkey"; keys: string }
  | { type: "type"; text: string }
  | { type: "shell"; command: string }
  | { type: "media"; command: "playpause" | "next" | "previous" }
  | { type: "volume"; command: "up" | "down" | "mute" }
  | { type: "page"; page: string }
  | { type: "sound"; sound: string; on?: SoundTarget; volume?: number; mode?: SoundMode }
  | { type: "sound-stop" }
  | { type: "hass"; service: string; entityId?: string; data?: Record<string, unknown> }
  | { type: "macro"; steps: MacroStep[] };

export type SoundTarget = "mac" | "phone" | "both";
export type SoundMode = "overlap" | "restart" | "toggle";
/** An uploaded clip. `id` is the value stored in actions (`snd:<16hex>`). */
export interface Sound {
  id: string;
  name: string;
  size?: number;
  duration?: number;
  type?: string;
}

export type ActionType = Action["type"];
export const ACTION_TYPES: ActionType[] = ["open", "hotkey", "type", "shell", "media", "volume", "page", "sound", "sound-stop", "hass", "macro"];

export type AiProvider = "omni" | "claude" | "codex" | "antigravity" | "opencode" | "grok";
export const AI_PROVIDERS: AiProvider[] = ["omni", "claude", "codex", "antigravity", "opencode", "grok"];
/** Providers whose quota can be read (Grok has no usage API). */
export const QUOTA_PROVIDERS: AiProvider[] = ["omni", "claude", "codex", "antigravity", "opencode"];

export type ClockStyle = "digital" | "flip" | "analog" | "minimal" | "word" | "world";
export const CLOCK_STYLES: ClockStyle[] = ["digital", "flip", "analog", "minimal", "word", "world"];
export interface ClockOptions {
  style?: ClockStyle;
  seconds?: boolean;
  hour12?: boolean;
  showDate?: boolean;
  timeZone?: string;
  zones?: string[];
  label?: string;
}

export type QuotaChart = "auto" | "bars" | "rings" | "gauge" | "meter" | "number" | "history";
export const QUOTA_CHARTS: QuotaChart[] = ["auto", "bars", "rings", "gauge", "meter", "number", "history"];
export interface QuotaOptions {
  chart?: QuotaChart;
  /** Which quota windows to show: all, the main one, or a list of window ids in display order (1-6, first is the main one). */
  windows?: "all" | "main" | string[];
  showReset?: boolean;
  account?: string;
}

export interface MacApp {
  name: string;
  bundleId: string;
  path?: string;
  /** App category (macOS LSApplicationCategoryType short id; Windows may send none). `bundleId` is the opaque app id on every platform. */
  category?: string;
}

export interface CatalogIcon {
  c: string;
  t: string[];
  /** Outline (stroke) inner markup; a few Tabler icons only have F. */
  O?: string;
  /** Filled inner markup. */
  F?: string;
}
/** A LobeHub brand mark: `color` marks ones that carry their own fills; the rest are monochrome (currentColor). */
export interface CatalogBrand {
  vb: string;
  body: string;
  color: boolean;
}
export interface IconCatalog {
  categories: string[];
  icons: Record<string, CatalogIcon>;
  brands?: Record<string, CatalogBrand>;
}

export type MetricChart = "sparkline" | "area" | "bars" | "gauge" | "ring" | "bar" | "number" | "donut";
export const METRIC_WIDGETS = ["cpu", "memory", "network", "load"] as const;
export type MetricWidget = (typeof METRIC_WIDGETS)[number];
export const METRIC_CHARTS_FOR: Record<MetricWidget, MetricChart[]> = {
  cpu: ["sparkline", "area", "bars", "gauge", "ring", "bar", "number"],
  memory: ["sparkline", "area", "bars", "gauge", "ring", "bar", "number", "donut"],
  network: ["sparkline", "area", "bars", "number"],
  load: ["sparkline", "area", "bars", "number"],
};
export const METRIC_WINDOWS = [60, 300, 900] as const;
export interface MetricOptions {
  chart?: MetricChart;
  window?: 60 | 300 | 900;
  showDelta?: boolean;
  showSub?: boolean;
}

export type WidgetKind = "clock" | "cpu" | "memory" | "uptime" | "load" | "network" | "nowplaying" | "quota" | "sessions" | "entity" | "weather" | "value" | "notifications" | "polymarket";
export const WIDGET_KINDS: WidgetKind[] = ["clock", "cpu", "memory", "uptime", "load", "network", "nowplaying", "quota", "sessions", "entity", "weather", "value", "notifications", "polymarket"];

export interface WeatherOptions {
  source?: "auto" | "hass" | "open-meteo";
  entity?: string;
  location?: { name: string; lat: number; lon: number };
  show?: "now" | "hourly" | "daily" | "auto";
  units?: "metric" | "imperial";
}
export interface PushOptions { key: string; label?: string; unit?: string }

export type MacroStep =
  | { kind: "hotkey"; keys: string }
  | { kind: "type"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "open"; target: string }
  | { kind: "shell"; command: string }
  | { kind: "media"; command: "playpause" | "next" | "previous" }
  | { kind: "volume"; command: "up" | "down" | "mute" }
  | { kind: "hass"; service: string; entityId?: string; data?: Record<string, unknown> }
  | { kind: "item"; pageId: string; itemId: string }
  | { kind: "notify"; text: string };
export const MACRO_MAX_STEPS = 20;
export const MACRO_MAX_WAIT_MS = 30000;

export type RuleWhen =
  | { kind: "ai-waiting"; provider?: "claude" | "codex"; includePrompts?: boolean }
  | { kind: "media-playing" }
  | { kind: "media-stopped" }
  | { kind: "cpu-above"; percent: number; forSec?: number }
  | { kind: "quota-above"; provider: "claude" | "codex" | "antigravity"; percent: number }
  | { kind: "time-between"; from: string; to: string; days?: number[] }
  | { kind: "push"; key: string; op?: "=" | "!=" | ">" | "<"; value?: string | number }
  | { kind: "hass-state"; entityId: string; state: string }
  | { kind: "idle"; minutes: number };
export type RuleThen =
  | { kind: "goto-page"; pageId: string; countdown?: number }
  | { kind: "notify"; text: string; level?: "info" | "warn" | "alert" }
  | { kind: "theme-mode"; mode: "dark" | "light" }
  | { kind: "run-item"; pageId: string; itemId: string };
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: RuleWhen;
  then: RuleThen[];
  revert?: boolean;
}
export const RULES_MAX = 40;

export interface GeoPlace { name: string; lat: number; lon: number; detail?: string }
export interface WebhookInfo {
  /** Key with the middle hidden; the full key is only fetched on demand (copy). */
  keyMasked: string;
  /** curl examples from the agent with "<KEY>" as the placeholder, using its LAN IP and .local name. */
  examples: string[];
}

/** Home Assistant entity tile options. */
export interface EntityOptions {
  id: string;
  name?: string;
  readOnly?: boolean;
  show?: "auto" | "state" | "value" | "toggle";
  /** Tap action for domains with a detail sheet: open the control sheet or just toggle. */
  tap?: "sheet" | "toggle";
  /** Show the domain's controls on the tile itself when it is big enough. */
  inlineControls?: boolean;
}

export interface HassConfig {
  url: string;
  hasToken: boolean;
  connected: boolean;
  error?: string;
  version?: string;
}
export interface HassEntity {
  id: string;
  name: string;
  domain: string;
  area?: string;
  state?: string;
  icon?: string;
}
export interface HassService {
  id: string;
  name?: string;
  description?: string;
}

export interface Size {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export type TileStyle = "tint" | "solid" | "outline" | "ios";
export const TILE_STYLES: TileStyle[] = ["tint", "solid", "outline", "ios"];

export interface ItemStyle {
  style?: TileStyle;
  textColor?: string;
  hideLabel?: boolean;
}

export type Item =
  | ({ id: string; kind: "button"; label: string; icon?: string; color?: string; action?: Action } & Size & ItemStyle)
  | ({ id: string; kind: "widget"; widget: WidgetKind; color?: string; provider?: AiProvider; clock?: ClockOptions; metric?: MetricOptions; quota?: QuotaOptions; entity?: EntityOptions; weather?: WeatherOptions; push?: PushOptions } & Size & ItemStyle);

export type ThemeOrientation = "landscape" | "portrait" | "auto";

export interface Theme {
  /** UI language for this page and the phone overlay; missing means English. */
  language?: "en" | "vi";
  /** Unit for every temperature on the phone; missing means Celsius. A weather widget's own `units` wins for that widget. */
  temperatureUnit?: "c" | "f";
  /** Look for a newer PhoneDesk once a day; missing means on. */
  updateCheck?: boolean;
  mode?: "dark" | "light" | "auto";
  accent?: string;
  background?: string;
  tile?: string;
  radius?: number;
  gap?: number;
  fontScale?: number;
  tileStyle?: TileStyle;
  iconScale?: number;
  /** Outline icon stroke width, 1-3 (default 2.25). */
  iconStroke?: number;
  showLabels?: boolean;
  text?: string;
  orientation?: ThemeOrientation;
}

export interface Page {
  id: string;
  name: string;
  columns: number;
  rows: number;
  items: Item[];
}

export interface Layout {
  version: 1;
  theme?: Theme;
  pages: Page[];
  rules?: Rule[];
  /** Icon images the deck needs (app icons, uploads), keyed by icon value; only sent to the preview, never saved by this page. */
  assets?: Record<string, unknown>;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeen?: string;
  /** When the pairing lapses if the device is not used (ISO string or epoch ms). */
  expiresAt?: string | number;
  online?: boolean;
}

export interface Pairing {
  pin: string;
  /** Link using the IP address. */
  url: string;
  /** Link using the .local name (http://<name>.local:<port>/?pin=...), when the agent has one. */
  urlLocal?: string;
  lanIp?: string;
  port?: number;
}

export const THEME_DEFAULTS = {
  mode: "dark" as const,
  accent: "#22d3ee",
  background: "#0b0b0d",
  tile: "#141417",
  radius: 14,
  gap: 10,
  fontScale: 1,
  tileStyle: "tint" as TileStyle,
  iconScale: 1,
  iconStroke: 2.25,
  showLabels: true,
  orientation: "landscape" as ThemeOrientation,
};

export const MAX_COLUMNS = 12;
export const MAX_ROWS = 8;

/** What GET /api/integrations returns for one tool, after normalising (see api.ts). */
export type DoctorStatus = "ok" | "missing" | "denied" | "unknown" | "n/a";
/** One macOS permission / dependency check from GET /api/doctor. */
export interface DoctorItem {
  id: string;
  status: DoctorStatus;
  name?: string;
  detail?: string;
  fix?: { text: string; settingsUrl?: string };
}

/** GET /api/about: what is running and where it comes from. */
export interface About {
  version: string;
  commit?: string;
  /** Built from a working tree with uncommitted changes: the commit does not match the code. */
  dirty?: boolean;
  buildDate?: string;
  platform?: string;
  arch?: string;
  /** Repository web URL, no trailing slash. */
  repo: string;
}

/** GET /api/update. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number | null;
  enabled: boolean;
  error?: string;
}

export interface Integration {
  id: AiProvider;
  name: string;
  /** Quota readable? "ok", "error" or "unknown" (not reported / not installed). */
  status: "ok" | "error" | "unknown";
  error?: string;
  plan?: string;
  updatedAt?: string;
  /** Where the quota comes from. */
  source?: "oauth" | "local" | "claude-code" | "codex" | "agy";
  /** Human reason the agent gives for where the quota comes from (read-only, no sign-in in PhoneDesk). */
  reason?: string;
  /** Quota windows as in the WebSocket "ai" message: usedPercent 0-100. */
  windows: { id: string; label: string; usedPercent: number; resetsAt?: string }[];
  hook?: { supported: boolean; enabled: boolean; settingsPath?: string };
  /** OpenCode and Grok: the tool is installed on this machine, its version (OpenCode), major line and running-session count. */
  cliInstalled?: boolean;
  version?: string;
  line?: number;
  sessions?: number;
  /** Why there is no quota (e.g. "Grok has no usage API"). */
  quotaReason?: string;
  /** Claude only: answer AskUserQuestion on the phone (separate PreToolUse hook). */
  askHook?: { enabled: boolean; idleOnly: boolean };
}

