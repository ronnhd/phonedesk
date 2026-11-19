// Wire types shared with the agent (mirrors src/config.ts; kept local so web/deck builds on its own).
export type Action =
  | { type: 'open'; target: string }
  | { type: 'hotkey'; keys: string }
  | { type: 'type'; text: string }
  | { type: 'shell'; command: string }
  | { type: 'media'; command: 'playpause' | 'next' | 'previous' }
  | { type: 'volume'; command: 'up' | 'down' | 'mute' }
  | { type: 'page'; page: string }
  | { type: 'sound'; sound: string; on?: 'mac' | 'phone' | 'both'; volume?: number; mode?: 'overlap' | 'restart' | 'toggle' }
  | { type: 'sound-stop' }
  | { type: 'macro'; steps: { kind: string; [k: string]: unknown }[] }
  | { type: 'hass'; service: string; entityId?: string; data?: { [k: string]: unknown } }

export type WidgetKind = 'clock' | 'cpu' | 'memory' | 'uptime' | 'load' | 'network' | 'nowplaying' | 'quota' | 'sessions' | 'entity' | 'weather' | 'value' | 'notifications' | 'polymarket'

export type ClockStyle = 'digital' | 'flip' | 'analog' | 'minimal' | 'word' | 'world'
export interface ClockOptions {
  style?: ClockStyle
  seconds?: boolean
  hour12?: boolean
  showDate?: boolean
  timeZone?: string
  zones?: string[]
  label?: string
}

export type QuotaChart = 'auto' | 'bars' | 'rings' | 'gauge' | 'meter' | 'number' | 'history'
export interface QuotaOptions {
  chart?: QuotaChart
  /** 'all' | 'main' (first window) | window ids in display order; the first is the hero */
  windows?: 'all' | 'main' | string[]
  showReset?: boolean
  account?: string
}

export type MetricChart = 'sparkline' | 'area' | 'bars' | 'gauge' | 'ring' | 'bar' | 'number' | 'donut'
export interface MetricOptions {
  chart?: MetricChart
  window?: 60 | 300 | 900
  showDelta?: boolean
  showSub?: boolean
}

export interface WeatherOptions {
  source?: 'auto' | 'hass' | 'open-meteo'
  entity?: string
  location?: { name: string; lat: number; lon: number }
  show?: 'now' | 'hourly' | 'daily' | 'auto'
  units?: 'metric' | 'imperial'
}
export interface PushOptions {
  key: string
  label?: string
  unit?: string
}
export interface WeatherData {
  now: { temp: number; condition?: string | number; text?: string; high?: number; low?: number; humidity?: number; wind?: number }
  hourly?: { t: number | string; temp: number; condition?: string | number }[]
  daily?: { t: number | string; high: number; low: number; condition?: string | number }[]
  source?: string
  /** unit the numbers are in ('C' | 'F' | '°C' ...); missing = the unit that was requested (open-meteo) or C */
  unit?: string
  location?: string
  updatedAt?: number | string
}
export interface PushedValue {
  value: string | number
  sub?: string
  items?: string[]
  unit?: string
  ttl?: number
  at: number
}
export interface Notice {
  id: string
  title: string
  body?: string
  level?: 'info' | 'warn' | 'alert'
  at: number
  ttl?: number
}
export interface GotoReq {
  id: string
  pageId: string
  countdown: number
  reason?: string
  at: number
}

export interface EntityOptions {
  id: string
  name?: string
  readOnly?: boolean
  show?: 'auto' | 'state' | 'value' | 'toggle'
}
/** one Home Assistant entity as the agent sends it ({type:'hass', entities, connected}) */
export interface HassEntity {
  state: string
  name?: string
  unit?: string
  icon?: string
  domain?: string
  attrs?: { [k: string]: unknown }
}
export interface HassState {
  entities: { [id: string]: HassEntity }
  connected: boolean
}

export type TileStyle = 'tint' | 'solid' | 'outline' | 'ios'
export type Orientation = 'landscape' | 'portrait' | 'auto'

export type Item = {
  id: string
  kind: 'button' | 'widget'
  x?: number
  y?: number
  style?: TileStyle
  textColor?: string
  hideLabel?: boolean
  provider?: AiProvider
  clock?: ClockOptions
  metric?: MetricOptions
  quota?: QuotaOptions
  entity?: EntityOptions
  weather?: WeatherOptions
  push?: PushOptions
  label?: string
  icon?: string
  color?: string
  action?: Action
  widget?: WidgetKind
  w?: number
  h?: number
}

export interface Theme {
  mode?: 'dark' | 'light' | 'auto'
  /** UI language of the overlays; missing = 'en' */
  language?: 'en' | 'vi'
  accent?: string
  background?: string
  tile?: string
  radius?: number
  gap?: number
  fontScale?: number
  tileStyle?: TileStyle
  iconStroke?: number
  iconScale?: number
  showLabels?: boolean
  text?: string
  orientation?: Orientation
  /** every temperature on the phone; missing = 'c' */
  temperatureUnit?: 'c' | 'f'
}

export interface Page {
  id: string
  name: string
  columns: number
  rows?: number
  items: Item[]
}

/** icon values the phone does not know: {svg: inner markup of a 24x24 icon} or {img: data URL} (app icons, uploaded images, catalog icons) */
export type IconAssets = { [value: string]: { svg?: string; img?: string; variant?: 'O' | 'F'; vb?: string; brand?: boolean } }

export interface Layout {
  version: 1
  theme?: Theme
  assets?: IconAssets
  pages: Page[]
}

export interface Stats {
  cpu: number
  memUsed: number
  memTotal: number
  uptime: number
  load: number[]
  /** what `load` measures: loadavg (unix load average), queue (Windows processor queue length), estimate (derived from CPU use) */
  loadKind?: 'loadavg' | 'queue' | 'estimate'
  time: number
  host?: string
  net?: { rx: number; tx: number }
  volume?: { level: number; muted: boolean } | null
}

export type MediaCommand = 'playpause' | 'next' | 'previous' | 'resume' | 'open'

export interface Media {
  app?: string
  title?: string
  artist?: string
  album?: string
  playing?: boolean
  position?: number
  duration?: number
  artwork?: string
  /** client clock (ms) when this update arrived, to advance the position locally */
  at?: number
}

export type AiProvider = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'grok'

export interface AiWindow {
  id: string
  label: string
  usedPercent: number
  resetsAt?: number | string
  windowMinutes?: number
  /** usedPercent samples [ms, percent], every 5 min for up to 24 h */
  history?: [number, number][]
}
export interface AiAccount {
  id: string
  email?: string
  label?: string
  status?: string
  displayName?: string
  plan?: string
  windows: AiWindow[]
  stale?: boolean
  fetchedAt?: number | string
}
export interface AiExtra {
  label: string
  value: number | string
  unit?: string
}
export interface AiProviderInfo {
  id: string
  source?: string
  status?: string
  email?: string
  label?: string
  accounts?: AiAccount[]
  extras?: AiExtra[]
  name: string
  plan?: string
  windows: AiWindow[]
  error?: string
  updatedAt?: number | string
}
export interface AiSession {
  id: string
  tool: string
  project: string
  title?: string
  model?: string
  state: 'working' | 'waiting' | 'idle'
  updatedAt: number | string
  tokens?: number
}
export interface AiData {
  providers: AiProviderInfo[]
  sessions: AiSession[]
}

export interface PermissionRequest {
  id: string
  source: 'claude' | 'codex' | 'opencode'
  project: string
  tool: string
  summary: string
  detail?: string
  risk?: 'low' | 'medium' | 'high'
  riskReason?: string
  sessionId?: string
  createdAt?: number | string
  expiresAt: number | string
}

/** Claude Code AskUserQuestion forwarded to the phone (PreToolUse hook) */
export interface QuestionItem {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  /** Claude: multiSelect. OpenCode: multiple. Either one turns the options into checkboxes. */
  multiSelect?: boolean
  multiple?: boolean
  /** OpenCode: false when only the listed options are allowed (no 'Other' field). Default true. */
  custom?: boolean
}
export interface QuestionRequest {
  id: string
  /** which tool is asking: 'claude' (default) or 'opencode' */
  source?: 'claude' | 'opencode'
  project: string
  sessionId?: string
  questions: QuestionItem[]
  createdAt?: number | string
  expiresAt: number | string
}

export interface ProcInfo {
  pid: number
  name: string
  cpu: number
  mem: number
}
