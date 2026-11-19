import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { t, setLang } from './i18n'
import { Icon, TileIcon, setIconStroke } from './icon'
import { soundKey } from './sounds'
import { ControlSheet } from './hass-controls'
import { DEFAULT_COLOR, HIST_LEN, Widget, type Hist } from './widgets'
import { DeckClient, savedDeviceName, type ClientState } from './client'
import { setTempUnit } from './temp'
import { shade, applyTheme, readableOn, tint } from './theme'
import { PROVIDER_COLOR } from './ai'
import { PermissionSheet, ProcessSheet, QuestionSheet } from './sheets'
import type { QuestionRequest, WeatherData, PushedValue, Notice, GotoReq, HassEntity, HassState, IconAssets, AiData, Item, Layout, Media, MediaCommand, Orientation, Page, Stats, TileStyle } from './types'

export { Icon }
import './deck.css'

export interface DeckProps {
  open: boolean
  /** Called after the close animation. Omit (or pass standalone) for an always-open deck. */
  onClose?: () => void
  /** Always open, no close button. */
  standalone?: boolean
  /** Agent origin when embedded in another site, e.g. "http://phonedesk.local:7420". Default: same origin. */
  baseUrl?: string
  /** Prefill for the pairing PIN. */
  pin?: string
  /** Preview mode (editor iframe): no pairing, no WebSocket, no actions; layout comes from postMessage. */
  preview?: boolean
}

const PAGE_KEY = 'pd.page'
const readPage = () => {
  try {
    return localStorage.getItem(PAGE_KEY)
  } catch {
    return null
  }
}
const writePage = (id: string) => {
  try {
    localStorage.setItem(PAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

const GB = 1024 * 1024 * 1024

const SAMPLE_STATS: Stats = {
  cpu: 37,
  memUsed: 8.2 * GB,
  memTotal: 16 * GB,
  uptime: 3 * 86400 + 4 * 3600,
  load: [1.2, 0.9, 0.8],
  time: 0,
  host: 'My computer',
  net: { rx: 2.4 * 1024 * 1024, tx: 245 * 1024 },
  volume: { level: 62, muted: false },
}
const SAMPLE_MEDIA: Media = {
  app: 'Spotify',
  title: 'Midnight Circuit',
  artist: 'Neon Harbor',
  album: 'After Hours',
  playing: true,
  position: 83,
  duration: 214,
  artwork: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>'),
}
/** 48 samples (5 min apart would be 4 h; the agent keeps 24 h): a rising 5 h window that resets once */
const sampleHistory = (seed: number, now: number, resetAt: number): [number, number][] => {
  const out: [number, number][] = []
  for (let i = 0; i < 48; i++) {
    const k = (i + seed) % resetAt
    out.push([now - (47 - i) * 30 * 60000, Math.min(96, 4 + k * (92 / resetAt) + Math.sin(i * 1.7 + seed) * 3)])
  }
  return out
}
/** preview: np=next swaps to this track (to see the track change transition) */
const SAMPLE_MEDIA2: Media = { app: 'Spotify', title: 'Slow Harbor', artist: 'The Lanterns', album: 'Night Ferry', playing: true, position: 3, duration: 225 }
/** preview np=sound: every sound button shows as playing (8 s) */
const sampleSounds = (l: Layout | null) => {
  const out: { [id: string]: { at: number; durMs?: number } } = {}
  ;((l && l.pages) || []).forEach((p) => p.items.forEach((it) => {
    if (it.action && it.action.type === 'sound') out[soundKey(it.action.sound)] = { at: Date.now(), durMs: 8000 }
  }))
  return out
}
/** The scene select that belongs to a light: attrs.related_select from the agent, else select.<light name>_*scene* from the same device. */
export const relatedSelect = (lightId: string, ents: { [id: string]: HassEntity }): { id: string; options: string[]; current: string } | null => {
  const l = ents[lightId]
  const given = l && l.attrs ? (l.attrs as { [k: string]: any }).related_select : undefined
  let sid = typeof given === 'string' && ents[given] ? given : ''
  if (!sid) {
    const base = 'select.' + lightId.split('.')[1]
    const ids = Object.keys(ents)
    for (let i = 0; i < ids.length; i++) if (ids[i].indexOf(base + '_') === 0 && ids[i].indexOf('scene') >= 0) { sid = ids[i]; break }
  }
  if (!sid) return null
  const s = ents[sid]
  const opts = s.attrs && Array.isArray((s.attrs as { [k: string]: unknown }).options) ? ((s.attrs as { [k: string]: unknown }).options as string[]) : []
  return opts.length ? { id: sid, options: opts, current: String(s.state) } : null
}
/** preview: every entity widget in the layout gets a plausible state by domain (np=ha-off shows the disconnected badge) */
const sampleHass = (l: Layout | null, off: boolean): HassState => {
  const ents: { [id: string]: HassEntity } = {}
  let lightN = 0
  let k = 0
  ;((l && l.pages) || []).forEach((p) => p.items.forEach((it) => {
    if (it.kind !== 'widget' || it.widget !== 'entity' || !it.entity) return
    const id = it.entity.id
    const dom = id.split('.')[0]
    k++
    if (dom === 'light') {
      // preview: odd lights are RGB lights on in magenta, the next one is warm white, then one off (Home Assistant's own attribute names)
      const n = lightN++ % 3
      const modes = ['color_temp', 'hs']
      if (n === 0) ents[id] = { state: 'on', name: 'Desk lamp', domain: dom, attrs: { brightness: 204, supported_color_modes: modes, color_mode: 'hs', hs_color: [300, 100], rgb_color: [255, 0, 255], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500, effect_list: ['None', 'rainbow', 'breathe'], effect: 'None' } }
      else if (n === 1) ents[id] = { state: 'on', name: 'Ball lamp', domain: dom, attrs: { brightness: 180, supported_color_modes: modes, color_mode: 'color_temp', color_temp_kelvin: 2700, min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 } }
      else ents[id] = { state: 'off', name: '3D lamp', domain: dom, attrs: { brightness: 0, supported_color_modes: modes, min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 } }
      const sid = 'select.' + id.split('.')[1] + '_scene'
      ents[sid] = { state: 'night', name: 'Scene', domain: 'select', attrs: { options: ['night', 'reading', 'party', 'sunrise'] } }
    }
    else if (dom === 'fan') ents[id] = { state: 'on', name: 'Air purifier', domain: dom, attrs: { percentage: 60, percentage_step: 20, preset_modes: ['auto', 'sleep', 'favorite'], preset_mode: 'auto', pm25: 12 } }
    else if (dom === 'cover') ents[id] = { state: 'open', name: 'Living room blinds', domain: dom, attrs: { current_position: 40, device_class: id.indexOf('garage') >= 0 ? 'garage' : id.indexOf('door') >= 0 ? 'door' : 'blind' } }
    else if (dom === 'vacuum') ents[id] = { state: 'docked', name: 'Robot vacuum', domain: dom, attrs: { battery_level: 80 } }
    else if (dom === 'switch') ents[id] = { state: 'off', name: 'Extractor fan', domain: dom }
    else if (dom === 'sensor') ents[id] = id.indexOf('hum') >= 0 || id.indexOf('am') >= 0 ? { state: '62', name: 'Humidity', unit: '%', domain: dom, attrs: { device_class: 'humidity' } } : { state: '28.4', name: 'Temperature', unit: '°C', domain: dom, attrs: { device_class: 'temperature' } }
    else if (dom === 'binary_sensor' && id.indexOf('door') >= 0) ents[id] = { state: 'off', name: 'Front door', domain: dom, attrs: { device_class: 'door' } }
    else if (dom === 'binary_sensor') ents[id] = { state: 'on', name: 'Living room presence', domain: dom, attrs: { device_class: 'occupancy' } }
    else if (dom === 'climate') ents[id] = { state: 'cool', name: 'Air conditioner', domain: dom, attrs: { current_temperature: 27.5, current_humidity: 62, temperature: 26, min_temp: 16, max_temp: 30, hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'], fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'auto', swing_modes: ['off', 'vertical', 'horizontal', 'both'], swing_mode: 'off' } }
    else if (dom === 'lock') ents[id] = { state: 'locked', name: 'Front door lock', domain: dom }
    else ents[id] = { state: 'on', name: id, domain: dom }
  }))
  return { entities: ents, connected: !off }
}
const SAMPLE_QUESTION: QuestionRequest = {
  id: 'q1',
  project: 'PhoneDesk',
  sessionId: '3f9a1c27-0000',
  createdAt: Date.now(),
  expiresAt: Date.now() + 9 * 60000,
  questions: [
    { header: 'Approach', question: 'How should the config be stored?', options: [{ label: 'JSON file', description: 'Simple, easy to edit by hand' }, { label: 'SQLite', description: 'Queryable, heavier' }] },
    { header: 'Features', question: 'Which features should be enabled?', multiSelect: true, options: [{ label: 'Weather', description: 'Open-Meteo' }, { label: 'Webhook' }, { label: 'Rules', description: 'Switch pages automatically' }] },
  ],
}
/** OpenCode question: several options at once are allowed (multiple) and the user may type their own (custom) */
const SAMPLE_QUESTION_OC: QuestionRequest = {
  id: 'q2',
  source: 'opencode',
  project: 'phone-api',
  sessionId: 'ses_8c1f00aa',
  createdAt: Date.now(),
  expiresAt: Date.now() + 9 * 60000,
  questions: [{ header: 'Providers', question: 'Which providers should the CLI support?', multiple: true, custom: true, options: [{ label: 'OpenAI', description: 'Chat and responses API' }, { label: 'Anthropic' }, { label: 'Ollama', description: 'Local models' }] }],
}
const SAMPLE_NOTES: Notice[] = [
  { id: 'n1', title: 'Build finished', body: 'my-app · 24 tests passed', level: 'info', at: Date.now() - 40000 },
  { id: 'n2', title: 'Disk almost full', body: 'Data volume has 4% free', level: 'warn', at: Date.now() - 12 * 60000 },
  { id: 'n3', title: 'Front door opened', level: 'alert', at: Date.now() - 2 * 3600000 },
  { id: 'n4', title: 'Backup complete', level: 'info', at: Date.now() - 5 * 3600000 },
]
const sampleWeather = (l: Layout | null) => {
  const out: { [id: string]: WeatherData } = {}
  // a believable afternoon in Home Assistant's own words: the sun gives way to cloud, then a late shower
  const hs = ['partlycloudy', 'partlycloudy', 'cloudy', 'cloudy', 'rainy', 'rainy', 'cloudy', 'partlycloudy', 'sunny', 'sunny', 'sunny', 'partlycloudy']
  const ts = [31, 32, 32, 30, 28, 27, 27, 28, 29, 30, 30, 29]
  const days = ['partlycloudy', 'sunny', 'rainy', 'cloudy', 'pouring', 'partlycloudy', 'sunny']
  const hi = [33, 34, 30, 31, 28, 32, 34]
  const lo = [25, 26, 24, 25, 23, 25, 26]
  ;((l && l.pages) || []).forEach((p) => p.items.forEach((it) => {
    if (it.kind !== 'widget' || it.widget !== 'weather') return
    const h0 = new Date().setMinutes(0, 0, 0)
    const d0 = new Date().setHours(12, 0, 0, 0)
    out[it.id] = {
      now: { temp: 31, condition: it.id.indexOf('night') >= 0 ? 'clear-night' : it.id.indexOf('rain') >= 0 ? 'rainy' : it.id.indexOf('cloud') >= 0 ? 'cloudy' : it.id.indexOf('sun') >= 0 ? 'sunny' : 'partlycloudy', high: 34, low: 25, humidity: 68 },
      hourly: hs.map((c, i) => ({ t: h0 + i * 3600000, temp: ts[i], condition: c })),
      daily: days.map((c, i) => ({ t: d0 + i * 86400000, high: hi[i], low: lo[i], condition: c })),
      source: 'hass',
      location: 'Home',
      updatedAt: Date.now() - 4 * 60000,
    }
  }))
  return out
}
const sampleValues = (l: Layout | null) => {
  const out: { [k: string]: PushedValue } = {}
  ;((l && l.pages) || []).forEach((p) => p.items.forEach((it) => {
    if (it.kind === 'widget' && it.widget === 'value' && it.push) out[it.push.key] = { value: it.push.key.indexOf('old') >= 0 ? 12 : 245.3, sub: 'Updated via webhook', ttl: it.push.key.indexOf('old') >= 0 ? 60 : undefined, at: Date.now() - (it.push.key.indexOf('old') >= 0 ? 10 * 60000 : 90000) }
  }))
  return out
}
const SAMPLE_AI: AiData = {
  providers: [
    {
      id: 'claude',
      name: 'Claude',
      plan: 'Max 5x',
      source: 'claude-code',
      extras: [{ label: 'Credits', value: 12.4, unit: 'USD' }],
      windows: [
        { id: 'five_hour', label: '5 hours', usedPercent: 34, resetsAt: Date.now() + (2 * 60 + 10) * 60000, history: sampleHistory(3, Date.now(), 22) },
        { id: 'seven_day', label: '7 days', usedPercent: 61, resetsAt: Date.now() + (3 * 24 + 4) * 3600000, history: sampleHistory(9, Date.now(), 60) },
      ],
    },
    { id: 'codex', name: 'Codex', plan: 'Plus', windows: [{ id: 'primary', label: '30 days', usedPercent: 12, resetsAt: Date.now() + 95 * 60000 }] },
    { id: 'opencode', name: 'OpenCode', plan: 'Go', source: 'opencode', windows: [{ id: 'rolling', label: '5 hours', usedPercent: 42, resetsAt: Date.now() + 90 * 60000 }, { id: 'weekly', label: 'Weekly', usedPercent: 18, resetsAt: Date.now() + 4 * 86400000 }, { id: 'monthly', label: 'Monthly', usedPercent: 9, resetsAt: Date.now() + 19 * 86400000 }] },
    { id: 'grok', name: 'Grok', plan: 'SuperGrok', source: 'grok-agent', extras: [{ label: 'Prepaid balance', value: 8.5, unit: 'USD' }], windows: [{ id: 'weekly', label: 'Weekly credits', usedPercent: 37, resetsAt: Date.now() + 3 * 86400000 }] },
    { id: 'antigravity', name: 'Antigravity', windows: [{ id: 'gemini-5h', label: 'Gemini 5 hours', usedPercent: 5, resetsAt: Date.now() + 3 * 3600000 }, { id: 'gemini-weekly', label: 'Gemini weekly', usedPercent: 22, resetsAt: Date.now() + 4 * 86400000 }, { id: '3p-5h', label: '3rd-party 5 hours', usedPercent: 48, resetsAt: Date.now() + 2 * 3600000 }, { id: '3p-weekly', label: '3rd-party weekly', usedPercent: 63, resetsAt: Date.now() + 5 * 86400000 }] },
  ],
  sessions: [
    { id: 's1', tool: 'claude', project: 'PhoneDesk', model: 'Opus 5.5', state: 'working', updatedAt: Date.now() - 20000 },
    { id: 's2', tool: 'codex', project: 'api-server', model: 'gpt-5', state: 'waiting', updatedAt: Date.now() - 4 * 60000 },
    { id: 's3', tool: 'claude', project: 'web-app', model: 'Sonnet 5.5', state: 'idle', updatedAt: Date.now() - 52 * 60000 },
    { id: 's4', tool: 'opencode', project: 'phone-api', model: 'Kimi K2', state: 'working', updatedAt: Date.now() - 45000 },
    { id: 's5', tool: 'grok', project: 'notes-app', model: 'Grok Build', state: 'waiting', updatedAt: Date.now() - 2 * 60000 },
  ],
}
const sampleSeries = (seed: number, base: number, amp: number) => {
  const out: number[] = []
  for (let i = 0; i < HIST_LEN; i++) out.push(Math.max(0, base + Math.sin(i / 5 + seed) * amp + Math.sin(i / 2.3 + seed * 2) * amp * 0.4))
  return out
}
const SAMPLE_HIST: Hist = { cpu: sampleSeries(1, 37, 15), mem: sampleSeries(2, 51, 4), rx: sampleSeries(3, 2.4e6, 1.4e6), tx: sampleSeries(5, 4e5, 2.5e5), load: sampleSeries(4, 1.2, 0.5) }

/** Font size (px) that keeps `chars` characters inside `avail` px; no CSS clamp()/container queries on Safari 12. */
const fit = (chars: number, avail: number, max: number, min: number) =>
  Math.max(min, Math.min(max, Math.floor(avail / (Math.max(1, chars) * 0.7))))

interface Placed extends Item {
  px: number // resolved cell x
  py: number // resolved cell y
  pw: number
  ph: number
}

/** Items with their cell resolved: explicit x/y kept (clamped to the grid), the rest go to the first free cell. */
function placeItems(page: Page): Placed[] {
  const cols = Math.max(1, page.columns | 0)
  const rows = Math.max(1, (page.rows || 4) | 0)
  const used: boolean[][] = []
  const mark = (x: number, y: number, w: number, hh: number) => {
    for (let r = y; r < y + hh; r++) {
      if (!used[r]) used[r] = []
      for (let c = x; c < x + w; c++) used[r][c] = true
    }
  }
  const free = (x: number, y: number, w: number, hh: number) => {
    for (let r = y; r < y + hh; r++) for (let c = x; c < x + w; c++) if (used[r] && used[r][c]) return false
    return true
  }
  const size = (it: Item) => ({
    w: Math.min(cols, Math.max(1, Math.round(it.w || 1))),
    h: Math.min(rows, Math.max(1, Math.round(it.h || 1))),
  })
  const out: Placed[] = []
  const pending: Item[] = []
  page.items.forEach((it) => {
    if (typeof it.x === 'number' && typeof it.y === 'number') {
      const z = size(it)
      const x = Math.min(cols - z.w, Math.max(0, Math.round(it.x)))
      const y = Math.min(rows - z.h, Math.max(0, Math.round(it.y)))
      mark(x, y, z.w, z.h)
      out.push(Object.assign({}, it, { px: x, py: y, pw: z.w, ph: z.h }))
    } else pending.push(it)
  })
  pending.forEach((it) => {
    const z = size(it)
    for (let y = 0; y + z.h <= rows; y++) {
      let done = false
      for (let x = 0; x + z.w <= cols && !done; x++) {
        if (free(x, y, z.w, z.h)) {
          mark(x, y, z.w, z.h)
          out.push(Object.assign({}, it, { px: x, py: y, pw: z.w, ph: z.h }))
          done = true
        }
      }
      if (done) return
    }
  })
  return out
}

function overlaps(items: Placed[], skipId: string, x: number, y: number, w: number, hh: number) {
  return items.some((o) => o.id !== skipId && x < o.px + o.pw && o.px < x + w && y < o.py + o.ph && o.py < y + hh)
}

interface Box {
  w: number // inner width available for the grid (px, local frame)
  h: number // inner height available for the grid (px)
  gap: number
}
const MIN_LABEL_CELL = 56 // below this cell size tiles are icon-only

/** Square cell size so the whole columns x rows grid fits in the box. */
function cellSize(page: Page, box: Box): number {
  const cols = Math.max(1, page.columns | 0)
  const rows = Math.max(1, (page.rows || 4) | 0)
  const cw = (box.w - box.gap * (cols - 1)) / cols
  const ch = (box.h - box.gap * (rows - 1)) / rows
  return Math.max(16, Math.floor(Math.min(cw, ch)))
}

interface TileTheme {
  style: TileStyle
  accent: string
  iconScale: number
  showLabels: boolean
  radius: number
}

function useClientState(client: DeckClient): ClientState {
  const [s, setS] = useState(client.state)
  useEffect(() => {
    setS(client.state)
    return client.subscribe(setS)
  }, [client])
  return s
}

const fsEl = () => (document as any).fullscreenElement || (document as any).webkitFullscreenElement
const fsSupported = () => {
  const d = document.documentElement as any
  return !!(d.requestFullscreen || d.webkitRequestFullscreen)
}

function Mark(props: { size: number }) {
  // brand "Live key": a cyan key, dark-cyan dither from the bottom-left, a green live dot
  return (
    <svg width={props.size} height={props.size} viewBox="80 80 352 352" aria-hidden="true" class="pd-mark">
      <defs>
        <clipPath id="pdk">
          <rect x="96" y="96" width="320" height="320" rx="84" />
        </clipPath>
      </defs>
      <rect x="96" y="96" width="320" height="320" rx="84" fill="#22d3ee" />
      <rect x="96" y="96" width="320" height="160" rx="84" fill="#ffffff" opacity=".10" />
      <g clip-path="url(#pdk)" fill="#155e75">
        <circle cx="104" cy="392" r="5.7" />
        <circle cx="136" cy="392" r="5.5" />
        <circle cx="168" cy="392" r="5.1" />
        <circle cx="200" cy="392" r="4.7" />
        <circle cx="232" cy="392" r="4.3" />
        <circle cx="120" cy="360" r="5.2" />
        <circle cx="152" cy="360" r="4.9" />
        <circle cx="184" cy="360" r="4.6" />
        <circle cx="104" cy="328" r="4.8" />
        <circle cx="136" cy="328" r="4.7" />
        <circle cx="168" cy="328" r="4.5" />
        <circle cx="120" cy="296" r="4.3" />
        <circle cx="152" cy="296" r="4.1" />
        <circle cx="104" cy="264" r="3.9" />
      </g>
      <circle cx="352" cy="160" r="40" fill="#34d399" />
      <circle cx="352" cy="160" r="40" fill="none" stroke="#0b0d10" stroke-width="16" />
    </svg>
  )
}

/** Thin progress ring drawn along the tile edge while a sound plays (stroke-dashoffset animation; the perimeter is computed, SVG pathLength is not reliable on Safari 12). */
/** preview flag np: comma separated, "clean" hides the empty-slot outlines (marketing screenshots): np=sound,clean */
let pvFahrenheit = false
let pvRotated = false
const splitNp = (s: string): { np: string; clean: boolean } => {
  const parts = s.split(',')
  pvFahrenheit = parts.indexOf('fahrenheit') >= 0
  pvRotated = parts.indexOf('rotated') >= 0
  const keep = (x: string) => x !== 'clean' && x !== 'fahrenheit' && x !== 'rotated'
  return { np: parts.filter(keep).join(','), clean: parts.indexOf('clean') >= 0 }
}

let entHoldT = 0
let entHeld = false

function SoundRing(props: { w: number; h: number; r: number; color: string; at: number; durMs?: number }) {
  // the elapsed time is fixed at mount, so re-renders never move a running animation
  const born = useRef(Date.now() - props.at)
  const sw = 2.5
  const w = Math.max(10, props.w - sw)
  const h = Math.max(10, props.h - sw)
  const r = Math.max(1, Math.min(props.r - sw / 2, w / 2, h / 2))
  const P = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r
  const known = !!props.durMs && props.durMs > 0
  const elapsed = born.current
  const st: { [k: string]: string } = { '--p': String(Math.round(P)) }
  if (known) {
    const dur = (props.durMs as number) / 1000
    const delay = -Math.min(dur, Math.max(0, elapsed / 1000))
    st.animationDuration = dur + 's'
    st.WebkitAnimationDuration = dur + 's'
    st.animationDelay = delay + 's'
    st.WebkitAnimationDelay = delay + 's'
  }
  return (
    <svg class="pd-snd" width={props.w} height={props.h} viewBox={'0 0 ' + props.w + ' ' + props.h} aria-hidden="true">
      <rect class={known ? 'pd-snd__r' : 'pd-snd__r pd-snd__r--ind'} x={sw / 2} y={sw / 2} width={w} height={h} rx={r} ry={r} fill="none" stroke={props.color} stroke-width={sw} stroke-linecap="round" stroke-dasharray={Math.round(P) + ' ' + Math.round(P)} style={st} />
    </svg>
  )
}

function Tile(props: {
  page: Page
  item: Placed
  stats: Stats | null
  fx: string
  selected: boolean
  dragging: boolean
  showHandle: boolean
  tw: number
  th: number
  scale: number
  tt: TileTheme
  preview: boolean
  ai: AiData | null
  waitingProjects: string[]
  onWidget: (kind: string) => void
  hist: Hist
  media: Media | null
  last: Media | null
  assets?: IconAssets
  onMedia: (c: MediaCommand, app?: string) => Promise<unknown> | void
  onVolume: (v: { level: number } | { muted: boolean }) => Promise<unknown> | void
  sound?: { at: number; durMs?: number }
  hassEnt?: HassEntity
  hassForceOn?: boolean
  hassConnected?: boolean
  wxData?: WeatherData
  pushed?: PushedValue
  notes?: Notice[]
  busy?: boolean
  entPend?: number
  onEntity?: (p: Page, i: Item, how: 'sheet') => void
  onStep?: (p: Page, i: Item, delta: number) => void
  onLight?: (p: Page, i: Item, op: string, value: unknown) => void
  onPress: (p: Page, i: Item) => void
  onDown: (e: PointerEvent, p: Page, i: Placed, kind: 'move' | 'resize') => void
}) {
  const { page, item, stats, fx } = props
  const style: { [k: string]: string } = {
    gridColumn: item.px + 1 + ' / span ' + item.pw,
    gridRow: item.py + 1 + ' / span ' + item.ph,
  }
  let cls = 'pd-tile' + (props.selected ? ' pd-sel' : '') + (props.dragging ? ' pd-dragging' : '') + (props.preview ? ' pd-tile--edit' : '')

  // colour: tint (soft fill + coloured border/icon) | solid (full fill) | outline (border + icon). rgba is computed
  // here because Safari 12 has no color-mix().
  let iconColor = ''
  let textColor = item.textColor || ''
  const sty: TileStyle = item.style || props.tt.style
  // a button without its own colour takes the theme accent, so tint / solid / outline never fall back to the same grey
  const baseCol = item.color || props.tt.accent
  if (baseCol && item.kind !== 'widget' && sty !== 'ios') {
    if (sty === 'solid') {
      style.background = baseCol
      style.borderColor = baseCol
      const fg = readableOn(baseCol) || '#ffffff'
      iconColor = fg
      if (!textColor) textColor = fg
    } else if (sty === 'outline') {
      style.background = 'transparent'
      style.borderColor = baseCol
      iconColor = baseCol
    } else {
      const bg = tint(baseCol, 0.16)
      style.borderColor = tint(baseCol, 0.45) || baseCol
      if (bg) style.background = bg
      iconColor = baseCol
    }
    cls += ' pd-tile--' + sty
  }
  // widgets: the same three looks in the widget's colour (item.color, else its natural colour, else the accent); ios = the default card
  let wInk = ''
  let wColor = item.color
  if (item.kind === 'widget' && sty !== 'ios') {
    const natural = item.widget === 'quota' ? (PROVIDER_COLOR[item.provider || 'claude'] || '#d97757') : DEFAULT_COLOR[item.widget || '']
    const wc = item.color || natural || props.tt.accent
    if (sty === 'solid') {
      style.background = wc
      style.borderColor = wc
      // dark ink wins on mid tones too (white on orange or cyan is under 3:1)
      wInk = readableOn(shade(wc, 0.25)) === '#ffffff' ? 'light' : 'dark'
      wColor = wInk === 'light' ? '#ffffff' : '#0b0d10'
      cls += ' pd-tile--wsolid pd-ink-' + wInk
    } else if (sty === 'outline') {
      style.background = 'transparent'
      style.borderColor = wc
      style.borderWidth = '1.5px'
      wColor = item.color || natural
      cls += ' pd-tile--wout'
    } else {
      const bg = tint(wc, 0.14)
      style.borderColor = tint(wc, 0.4) || wc
      if (bg) style.background = bg
      wColor = item.color || natural
      cls += ' pd-tile--wtint'
    }
  }
  const small = Math.min(props.tw, props.th) < MIN_LABEL_CELL
  const showLabel = props.tt.showLabels && !item.hideLabel && !small

  const down = props.preview ? (e: PointerEvent) => props.onDown(e, page, item, 'move') : undefined
  const handle = props.showHandle ? <span class="pd-handle" onPointerDown={(e) => props.onDown(e as PointerEvent, page, item, 'resize')} /> : null

  const entTap = !props.preview && item.kind === 'widget' && item.widget === 'entity' && !!item.entity && !item.entity.readOnly && (item.entity.id.indexOf('lock.') !== 0) && (item.entity.id.indexOf('sensor.') !== 0) && (item.entity.id.indexOf('binary_sensor.') !== 0) && (item.entity.id.indexOf('climate.') !== 0 ? true : true)
  const entDom = item.kind === 'widget' && item.widget === 'entity' && item.entity ? item.entity.id.split('.')[0] : ''
  // climate / cover / vacuum: a tap opens the control sheet; light / fan: a tap toggles and a long press (500 ms) opens it
  const sheetTap = entTap && (entDom === 'climate' || entDom === 'cover' || entDom === 'vacuum')
  const holdable = entTap && (entDom === 'light' || entDom === 'fan') && !!props.onEntity
  const entHoldStart = () => {
    clearTimeout(entHoldT)
    entHeld = false
    entHoldT = window.setTimeout(() => {
      entHeld = true
      if (props.onEntity) props.onEntity(page, item, 'sheet')
    }, 500)
  }
  const entHoldEnd = () => clearTimeout(entHoldT)
  const entClick = () => {
    if (entHeld) {
      entHeld = false
      return
    }
    if (sheetTap && props.onEntity) props.onEntity(page, item, 'sheet')
    else props.onPress(page, item)
  }
  const tappable = !props.preview && item.kind === 'widget' && (item.widget === 'cpu' || item.widget === 'memory')
  if (item.kind === 'widget') {
    return (
      <div
        class={cls + ' pd-tile--widget' + (entTap ? ' pd-tile--tap' : '') + (sty === 'ios' ? ' pd-tile--iosw' : '') + (item.widget === 'nowplaying' ? ' pd-tile--np' : '') + (tappable ? ' pd-tile--tap' : '')}
        style={style}
        data-id={item.id}
        onPointerDown={down}
        onClick={tappable ? () => props.onWidget(item.widget as string) : entTap ? () => entClick() : undefined}
        onTouchStart={holdable ? () => entHoldStart() : undefined}
        onTouchEnd={holdable ? entHoldEnd : undefined}
        onTouchMove={holdable ? entHoldEnd : undefined}
        onTouchCancel={holdable ? entHoldEnd : undefined}
        onMouseDown={holdable ? () => entHoldStart() : undefined}
        onMouseUp={holdable ? entHoldEnd : undefined}
        onMouseLeave={holdable ? entHoldEnd : undefined}
        onContextMenu={holdable ? (ev: Event) => ev.preventDefault() : undefined}
      >
        <Widget
          kind={item.widget || 'clock'}
          stats={stats}
          hist={props.hist}
          media={props.media}
          last={props.last}
          tw={props.tw}
          th={props.th}
          cw={item.w || 1}
          ch={item.h || 1}
          scale={props.scale}
          showLabel={props.tt.showLabels && !item.hideLabel}
          color={wColor}
          textColor={item.textColor || (wInk ? wColor : undefined)}
          provider={item.provider}
          clock={item.clock}
          metric={item.metric}
          quota={item.quota}
          entity={item.entity}
          weather={item.weather}
          entPend={props.entPend}
          onStep={props.onStep ? (dl: number) => props.onStep && props.onStep(page, item, dl) : undefined}
          onLight={props.onLight ? (op: string, v: unknown) => props.onLight && props.onLight(page, item, op, v) : undefined}
          push={item.push}
          wxData={props.wxData}
          pushed={props.pushed}
          notes={props.notes}
          hassEnt={props.hassEnt}
          hassForceOn={props.hassForceOn}
          hassConnected={props.hassConnected}
          assets={props.assets}
          ai={props.ai}
          waitingProjects={props.waitingProjects}
          preview={props.preview}
          onMedia={props.onMedia}
          onVolume={props.onVolume}
        />
        {handle}
      </div>
    )
  }
  if (sty === 'ios') {
    const ic = item.icon || ''
    const hasLabel = showLabel && !!item.label
    const lsz = Math.max(10, Math.min(13, fit((item.label || '').length, props.tw - 6, 12 * props.scale, 10)))
    // reserve the room of the biggest label size, so the icon square is the same on every tile; only the label text shrinks
    const labelH = hasLabel ? Math.round(Math.max(10, Math.min(13, 12 * props.scale)) * 1.25) + 5 : 0
    const sq = Math.max(24, Math.min(props.tw - 2, props.th - labelH - 2))
    const lobe = ic.indexOf('lobe:') === 0
    const asIs = ic.indexOf('app:') === 0 || ic.indexOf('img:') === 0 || lobe
    const base = item.color || props.tt.accent
    const gsz = Math.round(Math.min(sq * 0.78, sq * 0.5 * props.tt.iconScale))
    const sqStyle: { [k: string]: string } = { width: sq + 'px', height: sq + 'px', borderRadius: Math.round(sq * 0.225) + 'px' }
    if (lobe) {
      sqStyle.background = 'var(--pd-surface-2)'
      sqStyle.color = 'var(--pd-text)'
    }
    if (!asIs) {
      sqStyle.background = 'linear-gradient(180deg, ' + shade(base, 0.2) + ', ' + shade(base, -0.22) + ')'
      sqStyle.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.28), 0 1px 3px rgba(0,0,0,0.35)'
      // light fills (cyan, amber, mint) get a dark glyph: white on #22d3ee is only about 1.7:1, dark reads at about 11:1
      sqStyle.color = readableOn(base) || '#fff'
    }
    const lst: { [k: string]: string } = { fontSize: lsz + 'px' }
    if (item.textColor) lst.color = item.textColor
    return (
      <button
        type="button"
        class={cls + ' pd-tile--btn pd-tile--ios' + (fx ? ' pd-fx-' + fx : '')}
        style={style}
        data-id={item.id}
        aria-label={item.label || undefined}
        onClick={props.preview ? undefined : () => props.onPress(page, item)}
        onPointerDown={down}
      >
        <span class={'pd-ios__sq' + (asIs ? ' pd-ios__sq--asis' : '')} style={sqStyle}>
          {ic ? <TileIcon value={ic} size={lobe ? Math.round(sq * 0.6) : asIs ? sq : gsz} assets={props.assets} weight={props.sound ? 'Filled' : undefined} /> : null}
          {props.sound || props.busy ? <SoundRing w={sq} h={sq} r={Math.round(sq * 0.225)} color="#fff" at={props.sound ? props.sound.at : Date.now()} durMs={props.sound ? props.sound.durMs : undefined} /> : null}
        </span>
        {hasLabel ? (
          <span class="pd-ios__lb" style={lst}>
            {item.label}
          </span>
        ) : null}
        {handle}
      </button>
    )
  }
  const icon = item.icon || ''
  const noLabel = !showLabel || !item.label
  const base = Math.min(props.th * (noLabel ? 0.5 : 0.38), props.tw * (noLabel ? 0.55 : 0.42))
  const isz = Math.round(Math.max(16, Math.min(64, base)) * props.tt.iconScale * Math.min(1.3, props.scale))
  const lsz = Math.max(10, Math.min(15, fit((item.label || '').length, props.tw - 14, 14 * props.scale, 10)))
  const lstyle: { [k: string]: string } = { fontSize: lsz + 'px' }
  if (textColor) lstyle.color = textColor
  return (
    <button
      type="button"
      class={cls + ' pd-tile--btn' + (fx ? ' pd-fx-' + fx : '')}
      style={style}
      data-id={item.id}
      onClick={props.preview ? undefined : () => props.onPress(page, item)}
      onPointerDown={down}
    >
      {icon ? (
        <span class="pd-tile__ic" style={{ color: iconColor || undefined, marginBottom: noLabel ? '0' : undefined }}>
          <TileIcon value={icon} size={icon.indexOf('app:') === 0 || icon.indexOf('img:') === 0 || icon.indexOf('lobe:') === 0 ? Math.round(isz * 1.2) : isz} assets={props.assets} weight={props.sound ? 'Filled' : undefined} />
        </span>
      ) : null}
      {props.sound || props.busy ? <SoundRing w={props.tw} h={props.th} r={props.tt.radius} color={iconColor || item.color || props.tt.accent} at={props.sound ? props.sound.at : Date.now()} durMs={props.sound ? props.sound.durMs : undefined} /> : null}
      {!noLabel ? (
        <span class="pd-tile__lb" style={lstyle}>
          {item.label}
        </span>
      ) : null}
      {handle}
    </button>
  )
}

/** 6-cell PIN entry: one real (transparent) input over the cells, so the numeric keyboard, paste and autofill just work. */
function PinInput(props: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [focus, setFocus] = useState(false)
  const cells = []
  for (let i = 0; i < 6; i++) {
    const on = focus && i === Math.min(props.value.length, 5)
    cells.push(
      <span key={i} class={'pd-pin__c' + (props.value[i] ? ' pd-pin__c--f' : '') + (on ? ' pd-pin__c--on' : '')}>
        {props.value[i] || ''}
      </span>
    )
  }
  return (
    <div class="pd-pin" onClick={() => ref.current && ref.current.focus()}>
      <div class="pd-pin__cells">{cells}</div>
      <input
        ref={ref}
        class="pd-pin__in"
        value={props.value}
        inputMode="numeric"
        pattern="[0-9]*"
        autocomplete="one-time-code"
        aria-label={t('PIN')}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6))}
      />
    </div>
  )
}

/** Pulls the PIN out of a scanned QR: a PhoneDesk pair URL (?pin=123456) or a bare 6-digit PIN. */
const pinFromQr = (text: string): string => {
  const s = (text || '').replace(/^\s+|\s+$/g, '')
  if (/^\d{6}$/.test(s)) return s
  const m = /[?&#]pin=(\d{6})(?:[&#]|$)/.exec(s)
  return m ? m[1] : ''
}
/** Reads the photo into a canvas (at most `max` px on the long side) and returns its pixels. */
function imageData(url: string, max: number): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * k))
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * k))
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      const cx = cv.getContext('2d')
      if (!cx) return resolve(null)
      cx.drawImage(img, 0, 0, w, h)
      try {
        resolve(cx.getImageData(0, 0, w, h))
      } catch (e) {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
/** Decodes a QR from a photo with jsQR (pinned 1.4.0, loaded only when asked); tries a few sizes because phone photos are huge. */
async function scanPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const mod: any = await import('jsqr')
    const jsQR = mod.default || mod
    const sizes = [1400, 900, 600, 2000]
    for (let i = 0; i < sizes.length; i++) {
      const px = await imageData(url, sizes[i])
      if (!px) continue
      const r = jsQR(px.data, px.width, px.height, { inversionAttempts: 'attemptBoth' })
      if (r && r.data) return pinFromQr(r.data) || ''
    }
    return ''
  } finally {
    URL.revokeObjectURL(url)
  }
}

function PairForm(props: { client: DeckClient; notice: string; pin?: string }) {
  const [pin, setPin] = useState(props.pin || '')
  const [name, setName] = useState(savedDeviceName)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const doPair = (code: string) => {
    if (code.length < 6) {
      setErr(t('The PIN has 6 digits.'))
      return
    }
    setErr('')
    setBusy(true)
    props.client
      .pair(code, name.trim() || savedDeviceName())
      .then(() => setPin(''))
      .catch((x) => setErr((x && x.message) || String(x)))
      .then(() => setBusy(false))
  }
  const submit = (e: Event) => {
    e.preventDefault()
    doPair(pin)
  }
  const onPhoto = (e: Event) => {
    const inp = e.target as HTMLInputElement
    const f = inp.files && inp.files[0]
    inp.value = ''
    if (!f) return
    setErr('')
    setScanning(true)
    scanPhoto(f)
      .then((code) => {
        setScanning(false)
        if (!code) {
          setErr(t('No QR code found. Hold the phone closer and try again.'))
          return
        }
        setPin(code)
        doPair(code)
      })
      .catch(() => {
        setScanning(false)
        setErr(t('No QR code found. Hold the phone closer and try again.'))
      })
  }
  const msg = err || props.notice
  return (
    <div class="pd-pair">
      <form class="pd-card" onSubmit={submit} autocomplete="off">
        <div class="pd-card__brand">
          <Mark size={52} />
          <h1>PhoneDesk</h1>
        </div>
        <p class="pd-muted">{t('Enter the 6-digit PIN shown on your computer.')}</p>
        <PinInput value={pin} onChange={setPin} />
        <label class={'pd-scan' + (scanning || busy ? ' pd-scan--off' : '')}>
          <input type="file" accept="image/*" capture="environment" onChange={onPhoto} disabled={scanning || busy} />
          <span>{scanning ? t('Reading…') : t('Scan QR')}</span>
        </label>
        <p class="pd-hint pd-hint--pin">{t('Or scan the QR on your computer with the Camera app.')}</p>
        <label class="pd-field">
          {t('Device name')}
          <input value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <button type="submit" class="pd-primary" disabled={busy}>
          {t('Pair')}
        </button>
        <p class={'pd-error' + (msg ? ' pd-error--on' : '')} role="alert">
          {msg}
        </p>
        <p class="pd-hint">{t('Open the Manage page on your computer, Devices tab, to see the PIN / QR code')}</p>
      </form>
    </div>
  )
}

interface Drag {
  kind: 'move' | 'resize'
  pageId: string
  itemId: string
  moved: boolean
  sx: number // pointer start, local px
  sy: number
  gx: number // grab offset inside the tile (move)
  gy: number
  rx: number // pointer, grid-relative px
  ry: number
  tx: number // target cell
  ty: number
  tw: number // target span
  th: number
  valid: boolean
}

const orientOf = (l: Layout | null): Orientation => (l && l.theme && l.theme.orientation) || 'landscape'

export function Deck(props: DeckProps) {
  const preview = !!props.preview
  const client = useMemo(() => new DeckClient(props.baseUrl), [props.baseUrl])
  const live = useClientState(client)
  const [pv, setPv] = useState<{ layout: Layout | null; selectedId: string | null; np: string; clean: boolean }>(() => {
    const q = new URLSearchParams(location.search)
    const n = splitNp(q.get('np') || '')
    return { layout: null, selectedId: null, np: n.np, clean: n.clean || q.get('clean') === '1' }
  })
  const st: ClientState = preview ? { status: 'online', layout: pv.layout, stats: SAMPLE_STATS, media: pv.np === 'last' || pv.np === 'empty' ? null : pv.np === 'next' ? SAMPLE_MEDIA2 : SAMPLE_MEDIA, lastMedia: pv.np === 'last' ? Object.assign({}, SAMPLE_MEDIA, { playing: false, at: Date.now() - 12 * 60000 }) : null, ai: SAMPLE_AI, perms: [], questions: pv.np === 'question' ? [SAMPLE_QUESTION] : pv.np === 'question-oc' ? [SAMPLE_QUESTION_OC] : [], notice: '', sounds: pv.np === 'sound' ? sampleSounds(pv.layout) : undefined, hass: sampleHass(pv.layout, pv.np === 'ha-off'), weather: sampleWeather(pv.layout), pushed: sampleValues(pv.layout), notes: SAMPLE_NOTES, goto: pv.np === 'goto' ? { id: 'g', pageId: ((pv.layout && pv.layout.pages[1]) || { id: '' }).id, countdown: 3, reason: 'Claude needs you', at: Date.now() } : null, modeOverride: null } : live
  const hass: HassState | undefined = st.hass
  // a real state update replaces the optimistic one
  useEffect(() => {
    if (hass) setOpt((o) => (Object.keys(o).length ? {} : o))
  }, [hass])
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [pageIdx, setPageIdx] = useState(0)
  const [fx, setFx] = useState<{ [k: string]: string }>({})
  const [toast, setToast] = useState('')
  const [sheet, setSheet] = useState<{ page: Page; item: Item } | null>(null)
  const [ovr, setOvr] = useState<{ [eid: string]: { [op: string]: any } }>({})
  const [pend, setPend] = useState<{ [eid: string]: number }>({})
  const tempT = useRef<{ [eid: string]: number }>({})
  const [toastLv, setToastLv] = useState('')
  const [run, setRun] = useState<{ [k: string]: boolean }>({})
  const [gt, setGt] = useState<{ req: GotoReq; left: number } | null>(null)
  const seenNote = useRef('')
  const [opt, setOpt] = useState<{ [id: string]: { on: boolean } }>({})
  const [closing, setClosing] = useState(false)
  const [full, setFull] = useState(false)
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [box, setBox] = useState<Box>(() => ({ w: window.innerWidth - 28, h: window.innerHeight - 160, gap: 10 }))
  const [proc, setProc] = useState<'cpu' | 'mem' | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const raf = useRef(0)
  const toastTimer = useRef(0)
  const restored = useRef(false)
  const idxRef = useRef(0)
  const active = props.open || !!props.standalone || preview

  const pages = (st.layout && st.layout.pages) || []
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  // last ~60 samples of each metric, kept client side for the sparklines
  const histRef = useRef<Hist>({ cpu: [], mem: [], rx: [], tx: [], load: [] })
  const lastStats = useRef<Stats | null>(null)
  if (!preview && st.stats && st.stats !== lastStats.current) {
    lastStats.current = st.stats
    const hs = histRef.current
    const push = (a: number[], v: number) => {
      a.push(v)
      if (a.length > HIST_LEN) a.shift()
    }
    push(hs.cpu, st.stats.cpu)
    push(hs.mem, st.stats.memTotal ? (st.stats.memUsed / st.stats.memTotal) * 100 : 0)
    push(hs.rx, st.stats.net ? st.stats.net.rx : 0)
    push(hs.tx, st.stats.net ? st.stats.net.tx : 0)
    push(hs.load, (st.stats.load && st.stats.load[0]) || 0)
  }
  const hist = preview ? SAMPLE_HIST : histRef.current
  const onMedia = (c: MediaCommand, app?: string) => {
    if (preview) return
    return client.media(c, app).then((r) => {
      if (!r.ok) showToast(r.error || t('Action failed'))
    })
  }
  const onVolume = (v: { level: number } | { muted: boolean }) => {
    if (preview) return
    return client.volume(v).then((r) => {
      if (!r.ok) showToast(r.error || t('Action failed'))
    })
  }
  const boxRef = useRef(box)
  boxRef.current = box
  const swiped = useRef(0)
  const touching = useRef(false)
  const startIdx = useRef(-1)
  const settleT = useRef(0)
  const lastScroll = useRef(0)
  const pendScroll = useRef(0)
  const vpRef = useRef(vp)
  vpRef.current = vp

  // rotate the whole deck 90deg when the phone is held the other way (theme.orientation)
  const orient = st.status === 'pair' ? 'auto' : preview && pvRotated ? 'landscape' : orientOf(st.layout)
  const rotated = (orient === 'landscape' && vp.h > vp.w) || (orient === 'portrait' && vp.w > vp.h)
  const rootStyle: { [k: string]: string } | undefined = rotated
    ? {
        top: '0',
        left: '0',
        right: 'auto',
        bottom: 'auto',
        width: vp.h + 'px',
        height: vp.w + 'px',
        transformOrigin: '0 0',
        WebkitTransformOrigin: '0 0',
        transform: 'translateX(' + vp.w + 'px) rotate(90deg)',
        WebkitTransform: 'translateX(' + vp.w + 'px) rotate(90deg)',
      }
    : undefined

  useEffect(() => {
    const on = () => {
      const set = () => setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }))
      set()
      window.setTimeout(set, 300) // iOS 12 reports the new size a tick late
    }
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    return () => {
      window.removeEventListener('resize', on)
      window.removeEventListener('orientationchange', on)
    }
  }, [])

  // connect only while visible (never in preview)
  useEffect(() => {
    if (!active || preview) return
    client.start()
    const vis = () => {
      if (document.visibilityState === 'visible') client.nudge()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      document.removeEventListener('visibilitychange', vis)
      client.stop()
    }
  }, [client, active, preview])

  // preview: layout + page + selection come from the parent (same origin only)
  useEffect(() => {
    if (!preview) return
    const on = (ev: MessageEvent) => {
      if (ev.origin !== location.origin) return
      const d = ev.data
      if (!d || d.type !== 'pd-preview') return
      // assets may sit inside the layout or next to it (same contract as the live 'layout' message)
      const lay = d.layout && d.assets && typeof d.assets === 'object' && !d.layout.assets ? Object.assign({}, d.layout, { assets: d.assets }) : d.layout
      const n = d.np !== undefined ? splitNp(String(d.np)) : null
      setPv((s) => ({ layout: lay || null, selectedId: d.selectedId || null, np: n ? n.np : s.np, clean: n ? n.clean || s.clean : s.clean }))
      if (d.pageId) {
        const i = ((d.layout && d.layout.pages) || []).findIndex((p: Page) => p.id === d.pageId)
        if (i >= 0) window.setTimeout(() => scrollTo(i), 0)
      }
    }
    window.addEventListener('message', on)
    if (window.parent !== window) window.parent.postMessage({ type: 'pd-ready' }, location.origin)
    return () => window.removeEventListener('message', on)
  }, [preview])

  // theme (a rule can override the mode while it is active; the layout is not changed)
  useEffect(() => {
    if (!rootRef.current) return
    applyTheme(rootRef.current, st.layout ? st.layout.theme : undefined)
    if (st.modeOverride) rootRef.current.setAttribute('data-pd-theme', st.modeOverride)
  }, [st.layout, active, st.modeOverride])

  // preview np=ha-sheet:<entity domain>: open that control sheet for the first matching entity
  useEffect(() => {
    if (!preview || !pv.np || pv.np.indexOf('ha-sheet') !== 0) return
    const want = pv.np.split(':')[1] || 'climate'
    for (let i = 0; i < pages.length; i++)
      for (let j = 0; j < pages[i].items.length; j++) {
        const it = pages[i].items[j]
        if (it.kind === 'widget' && it.widget === 'entity' && it.entity && it.entity.id.split('.')[0] === want) {
          setSheet({ page: pages[i], item: it })
          return
        }
      }
  }, [preview, pv.np, pv.layout])

  // a toast for each new notification, on any page
  useEffect(() => {
    const l = st.notes
    if (!l || !l.length) return
    if (!seenNote.current) {
      seenNote.current = l[0].id
      return
    }
    const fresh: Notice[] = []
    for (let i = 0; i < l.length && l[i].id !== seenNote.current; i++) fresh.push(l[i])
    seenNote.current = l[0].id
    if (fresh.length && !preview) showToast(fresh[fresh.length - 1].title + (fresh[fresh.length - 1].body ? ' · ' + fresh[fresh.length - 1].body : ''), fresh[fresh.length - 1].level || 'info')
  }, [st.notes])

  // goto request: immediate when countdown is 0, otherwise a visible countdown that can be cancelled
  useEffect(() => {
    const g = st.goto
    if (!g) return
    const i = pagesRef.current.findIndex((p) => p.id === g.pageId)
    if (i < 0) return
    if (g.countdown <= 0) {
      goTo(i)
      return
    }
    setGt({ req: g, left: Math.ceil(g.countdown) })
  }, [st.goto])
  useEffect(() => {
    if (!gt) return
    const t = window.setTimeout(() => {
      if (gt.left <= 1) {
        const i = pagesRef.current.findIndex((p) => p.id === gt.req.pageId)
        setGt(null)
        if (i >= 0) goTo(i)
      } else setGt({ req: gt.req, left: gt.left - 1 })
    }, 1000)
    return () => clearTimeout(t)
  }, [gt])

  // screen wake lock
  useEffect(() => {
    if (!active || preview) return
    let lock: any = null
    let dead = false
    const req = () => {
      const wl = (navigator as any).wakeLock
      if (!wl || document.visibilityState !== 'visible' || (lock && !lock.released)) return
      wl.request('screen').then(
        (l: any) => {
          if (dead) l.release()
          else lock = l
        },
        () => undefined
      )
    }
    req()
    document.addEventListener('visibilitychange', req)
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', req)
      if (lock) lock.release().catch(() => undefined)
    }
  }, [active, preview])

  // fullscreen state
  useEffect(() => {
    const on = () => setFull(!!fsEl())
    document.addEventListener('fullscreenchange', on)
    document.addEventListener('webkitfullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      document.removeEventListener('webkitfullscreenchange', on)
    }
  }, [])

  // no pinch / double-tap zoom (iOS 10+ ignores user-scalable=no)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let last = 0
    const gs = (e: Event) => e.preventDefault()
    const te = (e: TouchEvent) => {
      const now = Date.now()
      const t = e.target as HTMLElement
      const editable = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      if (now - last < 350 && !editable && e.changedTouches.length === 1) {
        e.preventDefault()
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      }
      last = now
    }
    root.addEventListener('gesturestart', gs)
    root.addEventListener('touchend', te, { passive: false } as AddEventListenerOptions)
    return () => {
      root.removeEventListener('gesturestart', gs)
      root.removeEventListener('touchend', te)
    }
  }, [active, st.status === 'pair'])

  /**
   * Move the strip to page i without reporting it. Never writes scrollLeft while a finger is down or the strip is still moving (fling / snap
   * settling, Chrome Android): a write then cancels the momentum and snaps back the other way. It waits for 120 ms of scroll silence instead;
   * a new touch cancels the pending write (the user takes over).
   */
  const scrollTo = (i: number, force?: boolean) => {
    const s = stripRef.current
    if (!s) return
    idxRef.current = i
    setPageIdx(i)
    window.clearTimeout(pendScroll.current)
    let tries = 0
    const put = () => {
      const el = stripRef.current
      if (!el) return
      if (!force && (touching.current || Date.now() - lastScroll.current < 120) && tries++ < 40) {
        pendScroll.current = window.setTimeout(put, 130)
        return
      }
      const x = idxRef.current * el.clientWidth
      if (Math.abs(el.scrollLeft - x) > 1) el.scrollLeft = x // instant: Safari 12 has no smooth scrollTo
    }
    put()
  }
  const report = (p: Page) => {
    if (preview) {
      if (window.parent !== window) window.parent.postMessage({ type: 'pd-page', pageId: p.id }, location.origin)
    } else writePage(p.id)
  }
  /** User-initiated page change. */
  const goTo = (i: number, force?: boolean) => {
    scrollTo(i, force)
    const p = pagesRef.current[i]
    if (p) report(p)
  }

  // measure the room the grid has (local frame, so it is right when the deck is rotated)
  const measure = () => {
    const strip = stripRef.current
    const page = strip && (strip.firstElementChild as HTMLElement | null)
    const grid = page && (page.firstElementChild as HTMLElement | null)
    if (!strip || !page || !grid) return
    const pcs = getComputedStyle(page)
    const gcs = getComputedStyle(grid) as any
    const px = (v: string | null) => parseFloat(v || '') || 0
    const gap = px(gcs.gridRowGap) || px(gcs.rowGap) || 0
    const next = {
      w: Math.round(strip.clientWidth - px(pcs.paddingLeft) - px(pcs.paddingRight)),
      h: Math.round(strip.clientHeight - px(pcs.paddingTop) - px(pcs.paddingBottom)),
      gap: Math.round(gap),
    }
    setBox((b) => (b.w === next.w && b.h === next.h && b.gap === next.gap ? b : next))
  }
  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(measure, 0)
    const RO = (window as any).ResizeObserver
    const ro = RO && stripRef.current ? new RO(measure) : null
    if (ro) ro.observe(stripRef.current)
    const t2 = window.setTimeout(measure, 320)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
      if (ro) ro.disconnect()
    }
  }, [active, st.status, st.layout, vp.w, vp.h, rotated])

  // restore the last page once the first layout arrives; keep position when the layout changes
  useEffect(() => {
    if (!pages.length) return
    let i = idxRef.current
    if (!restored.current && !preview) {
      const saved = readPage()
      const j = pages.findIndex((p) => p.id === saved)
      if (j >= 0) i = j
      restored.current = true
    }
    if (i >= pages.length) i = pages.length - 1
    const t = window.setTimeout(() => scrollTo(i), 0)
    return () => clearTimeout(t)
  }, [st.layout])

  // rotation / resize: re-snap to the current page
  useEffect(() => {
    if (!active) return
    const snap = () => {
      const s = stripRef.current
      if (!s) return
      if (touching.current || Date.now() - lastScroll.current < 120) {
        window.clearTimeout(pendScroll.current)
        pendScroll.current = window.setTimeout(snap, 130)
        return
      }
      const x = idxRef.current * s.clientWidth
      if (Math.abs(s.scrollLeft - x) > 1) s.scrollLeft = x
    }
    snap()
    const t = window.setTimeout(snap, 320)
    return () => clearTimeout(t)
  }, [active, vp.w, vp.h, rotated])

  // a finger on the strip: no programmatic scroll writes until it lifts (and the fling has settled)
  useEffect(() => {
    const s = stripRef.current
    if (!s) return
    const on = () => { touching.current = true; window.clearTimeout(pendScroll.current); if (startIdx.current < 0 || !settleT.current) startIdx.current = idxRef.current }
    const off = () => { touching.current = false }
    s.addEventListener('touchstart', on, { passive: true })
    s.addEventListener('touchend', off, { passive: true })
    s.addEventListener('touchcancel', off, { passive: true })
    return () => {
      s.removeEventListener('touchstart', on)
      s.removeEventListener('touchend', off)
      s.removeEventListener('touchcancel', off)
    }
  }, [st.status, st.layout])

  /**
   * Rotated deck: the strip's scroll axis is the screen's y axis, so native touch scrolling goes the wrong way. The strip gets touch-action:none and
   * swipes are read in the deck's own frame (client y == deck x when rotated 90deg). Left swipe in the deck = next page, with a rubber band at the ends.
   */
  useEffect(() => {
    const s = stripRef.current
    if (!s || !rotated || st.status === 'pair') return
    let t0: { x: number; y: number; t: number; id: number } | null = null
    let mode = 0 // 0 undecided, 1 swiping, -1 not a swipe
    let dx = 0
    const frame = (tt: Touch) => ({ x: tt.clientY, y: vpRef.current.w - tt.clientX })
    let startI = 0 // page index when the finger went down: the drag and the verdict are relative to it (onScroll keeps moving idxRef mid-drag)
    const base = () => startI * s.clientWidth
    const bounded = (v: number) => {
      const n = pagesRef.current.length
      const w = s.clientWidth
      const min = 0
      const max = Math.max(0, n - 1) * w
      if (v < min) return min + (v - min) / 3
      if (v > max) return max + (v - max) / 3
      return v
    }
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1) { mode = -1; return }
      const tg = e.target as HTMLElement | null
      if (tg && tg.closest && tg.closest('input, select, textarea, [data-noswipe]')) { mode = -1; return }
      const f = frame(e.touches[0])
      t0 = { x: f.x, y: f.y, t: Date.now(), id: e.touches[0].identifier }
      startI = idxRef.current
      mode = 0
      dx = 0
    }
    const move = (e: TouchEvent) => {
      if (!t0 || mode < 0) return
      let tt: Touch | null = null
      for (let i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === t0.id) tt = e.touches[i]
      if (!tt) return
      const f = frame(tt)
      dx = f.x - t0.x
      const dy = f.y - t0.y
      if (mode === 0) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        mode = Math.abs(dx) > Math.abs(dy) ? 1 : -1
      }
      if (mode === 1) {
        e.preventDefault()
        s.scrollLeft = bounded(base() - dx)
      }
    }
    const end = () => {
      if (!t0) return
      const was = mode
      const dt = Math.max(1, Date.now() - t0.t)
      const v = dx / dt
      t0 = null
      mode = 0
      if (was !== 1) return
      swiped.current = Date.now()
      const w = s.clientWidth
      let i = startI
      if (dx < -40 || (dx < -15 && v < -0.4)) i = Math.min(pagesRef.current.length - 1, i + 1)
      else if (dx > 40 || (dx > 15 && v > 0.4)) i = Math.max(0, i - 1)
      if (i !== idxRef.current) goTo(i, true)
      else s.scrollLeft = i * w
    }
    const click = (e: Event) => {
      if (Date.now() - swiped.current < 350) { e.stopPropagation(); e.preventDefault() }
    }
    s.addEventListener('touchstart', down, { passive: true })
    s.addEventListener('touchmove', move, { passive: false })
    s.addEventListener('touchend', end, { passive: true })
    s.addEventListener('touchcancel', end, { passive: true })
    s.addEventListener('click', click, true)
    return () => {
      s.removeEventListener('touchstart', down)
      s.removeEventListener('touchmove', move)
      s.removeEventListener('touchend', end)
      s.removeEventListener('touchcancel', end)
      s.removeEventListener('click', click, true)
    }
  }, [rotated, st.status, st.layout])

  /**
   * Rotated deck, every other scroller (sessions list, process sheet, question / permission sheets, HA sheets): drive scrollTop from the finger's
   * movement in the deck's frame (screen x), with a little momentum. Horizontal swipes are left to the page strip.
   */
  useEffect(() => {
    const root = rootRef.current
    if (!root || !rotated) return
    let el: HTMLElement | null = null
    let y0 = 0
    let x0 = 0
    let top0 = 0
    let mode = 0
    let lastY = 0
    let lastT = 0
    let vel = 0
    let anim = 0
    const fy = (tt: Touch) => vpRef.current.w - tt.clientX // deck y
    const find = (n: HTMLElement | null): HTMLElement | null => {
      while (n && n !== root) {
        if (n.scrollHeight > n.clientHeight + 1) {
          const oy = window.getComputedStyle(n).overflowY
          if (oy === 'auto' || oy === 'scroll') return n
        }
        n = n.parentElement
      }
      return null
    }
    const down = (e: TouchEvent) => {
      cancelAnimationFrame(anim)
      mode = 0
      el = null
      if (e.touches.length !== 1) return
      const tg = e.target as HTMLElement | null
      if (tg && tg.closest && tg.closest('input, [data-noswipe]')) return
      el = find(tg)
      if (!el) return
      y0 = fy(e.touches[0])
      x0 = e.touches[0].clientY
      top0 = el.scrollTop
      lastY = y0
      lastT = Date.now()
      vel = 0
    }
    const move = (e: TouchEvent) => {
      if (!el) return
      const tt = e.touches[0]
      if (!tt) return
      const y = fy(tt)
      if (mode === 0) {
        const dx = Math.abs(tt.clientY - x0)
        const dy = Math.abs(y - y0)
        if (dx < 8 && dy < 8) return
        mode = dy >= dx ? 1 : -1
      }
      if (mode !== 1) return
      e.preventDefault()
      const now = Date.now()
      if (now > lastT) vel = (lastY - y) / (now - lastT)
      lastY = y
      lastT = now
      el.scrollTop = top0 - (y - y0)
    }
    const end = () => {
      const s = el
      el = null
      if (!s || mode !== 1) return
      swiped.current = Date.now()
      let v = Date.now() - lastT < 80 ? vel : 0
      const step = () => {
        s.scrollTop += v * 16
        v *= 0.95
        if (Math.abs(v) > 0.02) anim = requestAnimationFrame(step)
      }
      anim = requestAnimationFrame(step)
    }
    root.addEventListener('touchstart', down, { passive: true })
    root.addEventListener('touchmove', move, { passive: false })
    root.addEventListener('touchend', end, { passive: true })
    root.addEventListener('touchcancel', end, { passive: true })
    return () => {
      cancelAnimationFrame(anim)
      root.removeEventListener('touchstart', down)
      root.removeEventListener('touchmove', move)
      root.removeEventListener('touchend', end)
      root.removeEventListener('touchcancel', end)
    }
  }, [rotated, st.status])

  /** One swipe moves one page: when the strip settles more than a page from where the touch began (no scroll-snap-stop on iOS 12 / old Chrome), step back to start +/- 1. */
  const settle = () => {
    settleT.current = 0
    const s = stripRef.current
    if (!s || !s.clientWidth || touching.current) return
    const st = startIdx.current
    startIdx.current = -1
    if (st < 0) return
    const i = Math.round(s.scrollLeft / s.clientWidth)
    if (Math.abs(i - st) > 1) {
      const to = Math.max(0, Math.min(pagesRef.current.length - 1, st + (i > st ? 1 : -1)))
      goTo(to, true)
    }
  }
  const onScroll = () => {
    lastScroll.current = Date.now()
    window.clearTimeout(settleT.current)
    settleT.current = window.setTimeout(settle, 150)
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const s = stripRef.current
      if (!s || !s.clientWidth) return
      const i = Math.round(s.scrollLeft / s.clientWidth)
      if (i !== idxRef.current && pagesRef.current[i]) {
        idxRef.current = i
        setPageIdx(i)
        report(pagesRef.current[i])
      }
    })
  }

  /** One Home Assistant control op; the optimistic value stays in ovr until the call fails or a few seconds pass. */
  const ctl = (page: Page, item: Item, op: string, value?: unknown): Promise<boolean> => {
    const eid = item.entity ? item.entity.id : ''
    if (!eid || preview) return Promise.resolve(false)
    // the sheet keeps short names for its optimistic values; the wire uses the canonical service-style ops (CONTROL_OPS in src/hass/control.ts)
    const dom = eid.split('.')[0]
    const ent = hass ? hass.entities[eid] : undefined
    let wireOp = op
    let wireVal: unknown = value
    let target = ''
    if (op === 'power') {
      wireOp = value === false ? 'turn_off' : 'turn_on'
      wireVal = undefined
    } else if (op === 'hue') {
      const hs = ent && ent.attrs ? (ent.attrs as { [k: string]: any }).hs_color : undefined
      wireOp = 'set_hs_color'
      wireVal = [value, Array.isArray(hs) && typeof hs[1] === 'number' ? hs[1] : 100]
    } else if (op === 'hs') {
      wireOp = 'set_hs_color'
    } else if (op === 'effect') {
      wireOp = 'set_effect'
    } else if (op === 'scene') {
      // the scene is a select entity on the same device: the op targets that entity, not the light
      wireOp = 'select_option'
      target = (hass && relatedSelect(eid, hass.entities)) ? (relatedSelect(eid, (hass as HassState).entities) as { id: string }).id : ''
    } else if (dom === 'cover' && (op === 'open' || op === 'close' || op === 'stop')) wireOp = op + '_cover'
    else {
      const m: { [k: string]: string } = { temperature: 'set_temperature', hvac_mode: 'set_hvac_mode', fan_mode: 'set_fan_mode', swing_mode: 'set_swing_mode', brightness: 'set_brightness', color_temp: 'set_color_temp', percentage: 'set_percentage', preset: 'set_preset_mode', position: 'set_cover_position', dock: 'return_to_base' }
      if (m[op]) wireOp = m[op]
    }
    if (value !== undefined) setOvr((o) => Object.assign({}, o, { [eid]: Object.assign({}, o[eid] || {}, { [op]: value }) }))
    const clear = () => setOvr((o) => { const n = Object.assign({}, o); const m = Object.assign({}, n[eid] || {}); delete m[op]; n[eid] = m; return n })
    return client.request({ type: 'hass-control', pageId: page.id, itemId: item.id, op: wireOp, value: wireVal, ...(target ? { entityId: target } : {}) }).then((r) => {
      if (!r.ok) {
        clear()
        showToast(r.error || t('Could not control the device'), 'alert')
      } else window.setTimeout(clear, 4000)
      return r.ok
    })
  }
  /** Climate -/+: the target moves at once, the call goes out 600 ms after the last tap. */
  const stepTemp = (page: Page, item: Item, delta: number) => {
    const eid = item.entity ? item.entity.id : ''
    const ent = hass && eid ? hass.entities[eid] : undefined
    if (!eid || !ent) return
    const a = (ent.attrs || {}) as { [k: string]: any }
    const stp = typeof a.target_temp_step === 'number' && a.target_temp_step > 0 ? a.target_temp_step : 1
    const min = typeof a.min_temp === 'number' ? a.min_temp : 16
    const max = typeof a.max_temp === 'number' ? a.max_temp : 30
    const base = pend[eid] !== undefined ? pend[eid] : typeof a.temperature === 'number' ? a.temperature : min
    const next = Math.min(max, Math.max(min, Math.round((base + delta * stp) / stp) * stp))
    setPend((p) => Object.assign({}, p, { [eid]: next }))
    clearTimeout(tempT.current[eid])
    tempT.current[eid] = window.setTimeout(() => {
      ctl(page, item, 'temperature', next).then((ok) => {
        window.setTimeout(() => setPend((p) => { const n = Object.assign({}, p); delete n[eid]; return n }), ok ? 1500 : 0)
      })
    }, 600)
  }

  const showToast = (text: string, level?: string) => {
    setToast(text)
    setToastLv(level || '')
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), level === 'alert' ? 4500 : 2600)
  }

  const mark = (key: string, v: string, ms = 0) => {
    setFx((f) => {
      const n = Object.assign({}, f)
      if (v) n[key] = v
      else delete n[key]
      return n
    })
    if (ms)
      window.setTimeout(
        () =>
          setFx((f) => {
            if (f[key] !== v) return f
            const n = Object.assign({}, f)
            delete n[key]
            return n
          }),
        ms
      )
  }

  const press = (page: Page, item: Item) => {
    if (item.kind === 'widget' && item.widget === 'entity' && item.entity) {
      const eid = item.entity.id
      const dom = eid.split('.')[0]
      const cur = hass ? hass.entities[eid] : undefined
      const key = page.id + '/' + item.id
      const flips = ['light', 'switch', 'fan', 'input_boolean', 'automation'].indexOf(dom) >= 0
      if (flips && cur && cur.state !== 'unavailable') {
        // optimistic flip, rolled back when the call fails or no state change arrives
        const next = cur.state !== 'on'
        setOpt((o) => Object.assign({}, o, { [eid]: { on: next } }))
        window.setTimeout(() => setOpt((o) => { const n = Object.assign({}, o); delete n[eid]; return n }), 5000)
      }
      mark(key, 'pressed', 150)
      client.press(page.id, item.id).then((r) => {
        if (r.ok) mark(key, 'ok', 600)
        else {
          setOpt((o) => { const n = Object.assign({}, o); delete n[eid]; return n })
          mark(key, 'error', 900)
          showToast(r.error || t('Action failed'))
        }
      })
      return
    }
    const a = item.action
    if (!a) return
    if (a.type === 'page') {
      const i = pages.findIndex((p) => p.id === a.page)
      if (i >= 0) goTo(i)
      else showToast(t('Page "{0}" not found', a.page))
      return
    }
    const key = page.id + '/' + item.id
    mark(key, 'pressed', 150)
    if (a.type === 'macro') {
      setRun((r) => Object.assign({}, r, { [key]: true }))
      window.setTimeout(() => setRun((r) => { const n = Object.assign({}, r); delete n[key]; return n }), 40000)
    }
    // iOS: audio has to start inside the tap, so unlock this sound's element now; the agent's play-sound message reuses it
    if (a.type === 'sound' && (a.on === 'phone' || a.on === 'both')) client.soundboard.unlock(a.sound)
    client.press(page.id, item.id).then((r) => {
      if (a.type === 'macro') setRun((x) => { const n = Object.assign({}, x); delete n[key]; return n })
      if (r.ok) mark(key, 'ok', 600)
      else {
        mark(key, 'error', 900)
        showToast(r.error || t('Action failed'))
      }
    })
  }

  // ---------- preview editing gestures (select / move / resize), reported to the parent ----------
  const post = (msg: { [k: string]: unknown }) => {
    if (window.parent !== window) window.parent.postMessage(msg, location.origin)
  }
  /** Client coordinates -> the deck's own (unrotated) frame. */
  const toLocal = (cx: number, cy: number) => (rotated ? { x: cy, y: vpRef.current.w - cx } : { x: cx, y: cy })
  const gridOrigin = (pageId: string) => {
    const g = rootRef.current && (rootRef.current.querySelector('[data-grid="' + pageId + '"]') as HTMLElement | null)
    if (!g) return null
    const r = g.getBoundingClientRect()
    const a = toLocal(r.left, r.top)
    const b = toLocal(r.right, r.bottom)
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
  }
  const dragTarget = (d: Drag, page: Page, items: Placed[], rx: number, ry: number): Drag => {
    const cell = cellSize(page, boxRef.current)
    const step = cell + boxRef.current.gap
    const cols = Math.max(1, page.columns | 0)
    const rows = Math.max(1, (page.rows || 4) | 0)
    const it = items.find((o) => o.id === d.itemId)
    if (!it) return d
    let tx = it.px
    let ty = it.py
    let tw = it.pw
    let th = it.ph
    let valid = true
    if (d.kind === 'move') {
      tx = Math.round((rx - d.gx) / step)
      ty = Math.round((ry - d.gy) / step)
      valid = tx >= 0 && ty >= 0 && tx + tw <= cols && ty + th <= rows
    } else {
      tw = Math.min(cols - it.px, Math.max(1, Math.round((rx - it.px * step + boxRef.current.gap) / step)))
      th = Math.min(rows - it.py, Math.max(1, Math.round((ry - it.py * step + boxRef.current.gap) / step)))
    }
    if (valid && overlaps(items, it.id, tx, ty, tw, th)) valid = false
    return Object.assign({}, d, { rx, ry, tx, ty, tw, th, valid })
  }
  const onDown = (e: PointerEvent, page: Page, item: Placed, kind: 'move' | 'resize') => {
    if (!preview || (e.button !== undefined && e.button !== 0)) return
    e.preventDefault()
    e.stopPropagation()
    const o = gridOrigin(page.id)
    if (!o) return
    const p = toLocal(e.clientX, e.clientY)
    const step = cellSize(page, boxRef.current) + boxRef.current.gap
    const items = placeItems(page)
    const start: Drag = {
      kind,
      pageId: page.id,
      itemId: item.id,
      moved: false,
      sx: p.x,
      sy: p.y,
      gx: p.x - o.x - item.px * step,
      gy: p.y - o.y - item.py * step,
      rx: p.x - o.x,
      ry: p.y - o.y,
      tx: item.px,
      ty: item.py,
      tw: item.pw,
      th: item.ph,
      valid: true,
    }
    dragRef.current = start
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const q = toLocal(ev.clientX, ev.clientY)
      const og = gridOrigin(page.id) || o
      const moved = d.moved || Math.abs(q.x - d.sx) + Math.abs(q.y - d.sy) > 6
      const next = dragTarget(Object.assign({}, d, { moved }), page, items, q.x - og.x, q.y - og.y)
      dragRef.current = next
      if (moved) setDrag(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d) return
      if (d.kind === 'move' && !d.moved) {
        post({ type: 'pd-select', pageId: page.id, itemId: item.id })
        setPv((s) => Object.assign({}, s, { selectedId: item.id }))
      } else if (d.valid && d.moved) {
        if (d.kind === 'move' && (d.tx !== item.px || d.ty !== item.py)) post({ type: 'pd-move', pageId: page.id, itemId: item.id, x: d.tx, y: d.ty })
        if (d.kind === 'resize' && (d.tw !== item.pw || d.th !== item.ph)) post({ type: 'pd-resize', pageId: page.id, itemId: item.id, w: d.tw, h: d.th })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const close = () => {
    if (closing) return
    setClosing(true)
    window.setTimeout(() => {
      setClosing(false)
      if (props.onClose) props.onClose()
    }, 140)
  }

  const toggleFull = () => {
    const d = document as any
    const r = document.documentElement as any
    try {
      if (fsEl()) (d.exitFullscreen || d.webkitExitFullscreen).call(d)
      else (r.requestFullscreen || r.webkitRequestFullscreen).call(r)
    } catch {
      /* ignore */
    }
  }

  if (!active) return null

  // long-press (800 ms) on the connection dot reloads the deck
  const holdT = useRef(0)
  const holdStart = () => {
    clearTimeout(holdT.current)
    if (preview) return
    holdT.current = window.setTimeout(() => client.reload(), 800)
  }
  const holdEnd = () => clearTimeout(holdT.current)
  const dotCls = st.status === 'online' ? 'pd-dot pd-dot--live' : st.status === 'connecting' ? 'pd-dot pd-dot--warn' : st.status === 'offline' ? 'pd-dot pd-dot--bad' : 'pd-dot'
  const statusText = st.status === 'pair' ? t('not paired') : st.status === 'online' ? t('connected') : st.status === 'connecting' ? t('connecting') : t('disconnected')
  const cur = pages[pageIdx]
  const canClose = !props.standalone && !preview && !!props.onClose
  const showFs = !preview && fsSupported() && st.status !== 'pair'
  const theme = (st.layout && st.layout.theme) || {}
  const scale = Math.min(2, Math.max(0.5, theme.fontScale || 1))
  setIconStroke(theme.iconStroke)
  setLang(theme.language)
  setTempUnit(preview && pvFahrenheit ? 'f' : theme.temperatureUnit)
  const tt: TileTheme = {
    style: theme.tileStyle === 'solid' || theme.tileStyle === 'outline' || theme.tileStyle === 'ios' ? theme.tileStyle : 'tint',
    accent: theme.accent || '#22d3ee',
    radius: typeof theme.radius === 'number' ? theme.radius : 16,
    iconScale: Math.min(2, Math.max(0.5, theme.iconScale || 1)),
    showLabels: theme.showLabels !== false,
  }

  return (
    <div class={'pd-root' + (preview ? ' pd-root--preview' : '') + (rotated ? ' pd-root--rot' : '') + (Math.min(vp.w, vp.h) <= 340 ? ' pd-root--sm' : '')} ref={rootRef} data-pd-theme="dark" style={rootStyle}>
      {st.reloading ? <div class="pd-veil">{t('Reloading…')}</div> : null}
      <div class={'pd-sheet' + (closing ? ' pd-sheet--closing' : '')}>
        <div class="pd-panel" role="dialog" aria-label="PhoneDesk">
          <div class="pd-head">
            <span class="pd-conn" title={statusText}>
              <span class="pd-dotbtn" onTouchStart={holdStart} onTouchEnd={holdEnd} onTouchCancel={holdEnd} onTouchMove={holdEnd} onMouseDown={holdStart} onMouseUp={holdEnd} onMouseLeave={holdEnd} onContextMenu={(e) => e.preventDefault()}>
                <i class={dotCls} />
              </span>
              <b>{st.status === 'pair' ? 'PhoneDesk' : (st.stats && st.stats.host) || 'PhoneDesk'}</b>
              {st.status !== 'pair' && st.status !== 'online' && !preview ? <em>{statusText}</em> : null}
              {st.status === 'online' && st.stats ? (
                <span class="pd-conn__m">
                  <span>CPU {Math.round(st.stats.cpu)}%</span>
                  <span>RAM {st.stats.memTotal ? Math.round((st.stats.memUsed / st.stats.memTotal) * 100) : 0}%</span>
                </span>
              ) : null}
            </span>
            <span class="pd-spacer" />
            {st.status !== 'pair' && cur ? <span class="pd-pagename">{cur.name || cur.id}</span> : null}
            {showFs ? (
              <button type="button" class="pd-iconbtn" aria-label={t('Fullscreen')} title={t('Fullscreen')} onClick={toggleFull}>
                <Icon name={full ? 'minimize' : 'maximize'} size={18} />
              </button>
            ) : null}
            {canClose ? (
              <button type="button" class="pd-iconbtn" aria-label={t('Close')} title={t('Close')} onClick={close}>
                <Icon name="x" size={18} />
              </button>
            ) : null}
          </div>

          {st.status === 'pair' ? (
            <PairForm client={client} notice={st.notice} pin={props.pin} />
          ) : (
            <>
              <div class={'pd-pager' + (rotated ? ' pd-pager--rot' : '')} ref={stripRef} onScroll={onScroll}>
                {pages.length === 0 ? (
                  <div class="pd-page">
                    <div class="pd-empty">{t('Waiting for layout...')}</div>
                  </div>
                ) : null}
                {pages.map((p, pi) => {
                  // only the page on screen and its neighbours get tiles: an old phone (iPhone 5s) chokes on building
                  // and re-rendering every page each second; the far pages stay as empty slides so swiping still lines up
                  if (!preview && Math.abs(pi - pageIdx) > 1) return <div class="pd-page" key={p.id} />
                  const cols = Math.max(1, p.columns | 0)
                  const rows = Math.max(1, (p.rows || 4) | 0)
                  const cell = cellSize(p, box)
                  const stretch = p.id === 'polymarket'
                  const cellW = stretch ? Math.max(16, Math.floor((box.w - box.gap * (cols - 1)) / cols)) : cell
                  const cellH = stretch ? Math.max(16, Math.floor((box.h - box.gap * (rows - 1)) / rows)) : cell
                  const step = cell + box.gap
                  const items = placeItems(p)
                  const dg = drag && drag.pageId === p.id ? drag : null
                  // empty slots (preview only): every cell no tile covers
                  const slots = []
                  if (preview && !pv.clean) {
                    for (let y = 0; y < rows; y++)
                      for (let x = 0; x < cols; x++) {
                        if (items.some((o) => x >= o.px && x < o.px + o.pw && y >= o.py && y < o.py + o.ph)) continue
                        slots.push(
                          <div
                            key={'s' + x + '-' + y}
                            class="pd-slot"
                            style={{ gridColumn: x + 1 + ' / span 1', gridRow: y + 1 + ' / span 1' }}
                            onClick={() => {
                              post({ type: 'pd-select', pageId: p.id, itemId: null, x, y })
                              setPv((s) => Object.assign({}, s, { selectedId: null }))
                            }}
                          />
                        )
                      }
                  }
                  return (
                    <div class="pd-page" key={p.id}>
                      <div
                        class="pd-grid"
                        data-grid={p.id}
                        style={{ gridTemplateColumns: 'repeat(' + cols + ', ' + cellW + 'px)', gridTemplateRows: 'repeat(' + rows + ', ' + cellH + 'px)' }}
                      >
                        {slots}
                        {items.map((it) => (
                          <Tile
                            key={it.id}
                            page={p}
                            item={it}
                            stats={st.stats}
                            fx={fx[p.id + '/' + it.id] || ''}
                            selected={preview && pv.selectedId === it.id}
                            dragging={!!dg && dg.itemId === it.id && dg.kind === 'move'}
                            showHandle={preview && pv.selectedId === it.id}
                            tw={cellW * it.pw + box.gap * (it.pw - 1)}
                            th={cellH * it.ph + box.gap * (it.ph - 1)}
                            scale={scale}
                            tt={tt}
                            preview={preview}
                            ai={st.ai}
                            waitingProjects={st.perms.map((p) => p.project)}
                            onWidget={(k) => setProc(k === 'memory' ? 'mem' : 'cpu')}
                            hist={hist}
                            media={st.media}
                            assets={st.layout ? st.layout.assets : undefined}
                            last={st.lastMedia}
                            onMedia={onMedia}
                            onVolume={onVolume}
                            hassEnt={it.entity && hass ? hass.entities[it.entity.id] : undefined}
                            hassForceOn={it.entity && opt[it.entity.id] ? opt[it.entity.id].on : undefined}
                            hassConnected={hass ? hass.connected : true}
                            wxData={st.weather ? st.weather[it.id] : undefined}
                            pushed={it.push && st.pushed ? st.pushed[it.push.key] : undefined}
                            notes={st.notes}
                            entPend={it.entity ? pend[it.entity.id] : undefined}
                            onEntity={(pg, itm) => setSheet({ page: pg, item: itm })}
                            onStep={stepTemp}
                            onLight={(pg, itm, op, v) => { ctl(pg, itm, op, v) }}
                            busy={!!run[p.id + '/' + it.id]}
                            sound={it.action && it.action.type === 'sound' && st.sounds ? st.sounds[soundKey(it.action.sound)] : undefined}
                            onPress={press}
                            onDown={onDown}
                          />
                        ))}
                        {dg && dg.moved ? (
                          <div
                            class={'pd-hl' + (dg.valid ? '' : ' pd-hl--bad')}
                            style={{
                              left: dg.tx * step + 'px',
                              top: dg.ty * step + 'px',
                              width: dg.tw * cell + (dg.tw - 1) * box.gap + 'px',
                              height: dg.th * cell + (dg.th - 1) * box.gap + 'px',
                            }}
                          />
                        ) : null}
                        {dg && dg.moved && dg.kind === 'move' ? (
                          <div
                            class="pd-ghost"
                            style={{
                              left: dg.rx - dg.gx + 'px',
                              top: dg.ry - dg.gy + 'px',
                              width: dg.tw * cell + (dg.tw - 1) * box.gap + 'px',
                              height: dg.th * cell + (dg.th - 1) * box.gap + 'px',
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
              {pages.length > 1 ? (
                <div class="pd-dots" role="tablist">
                  {pages.map((p, i) => (
                    <button key={p.id} type="button" role="tab" aria-label={p.name || p.id} class="pd-dots__b" onClick={() => goTo(i)}>
                      <span class={'pd-dots__d' + (i === pageIdx ? ' pd-dots__d--on' : '')} />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {sheet && sheet.item.entity && hass && hass.entities[sheet.item.entity.id] ? (
            <ControlSheet
              id={sheet.item.entity.id}
              ent={hass.entities[sheet.item.entity.id]}
              name={sheet.item.entity.name || hass.entities[sheet.item.entity.id].name || sheet.item.entity.id}
              ovr={ovr[sheet.item.entity.id] || {}}
              pend={pend[sheet.item.entity.id]}
              scene={relatedSelect(sheet.item.entity.id, hass.entities)}
              send={(op, v) => ctl(sheet.page, sheet.item, op, v)}
              step={(dl) => stepTemp(sheet.page, sheet.item, dl)}
              short={(rotated ? vp.w : vp.h) < 420}
              onClose={() => setSheet(null)}
            />
          ) : null}
          {!preview && proc && st.status === 'online' ? <ProcessSheet client={client} initial={proc} onClose={() => setProc(null)} /> : null}
          {!preview && st.perms.length ? <PermissionSheet client={client} perms={st.perms} /> : null}
          {st.questions && st.questions.length && (!preview || pv.np === 'question' || pv.np === 'question-oc') ? <QuestionSheet client={client} qs={st.questions} preview={preview} /> : null}
          {gt ? (
            <div class="pd-goto" role="alertdialog" aria-label={t('Change page')}>
              <div class="pd-goto__t">
                {t('Switching to')} <b>{(pages.find((p) => p.id === gt.req.pageId) || { name: gt.req.pageId }).name || gt.req.pageId}</b> {t('in {0} s', gt.left)}{gt.req.reason ? ' · ' + gt.req.reason : ''}
              </div>
              <div class="pd-goto__b">
                <button type="button" class="pd-goto__btn" onClick={() => setGt(null)}>
                  {t('Stay')}
                </button>
                <button
                  type="button"
                  class="pd-goto__btn pd-goto__btn--go"
                  onClick={() => {
                    const i = pages.findIndex((p) => p.id === gt.req.pageId)
                    setGt(null)
                    if (i >= 0) goTo(i)
                  }}
                >
                  {t('Go now')}
                </button>
              </div>
              <div class="pd-goto__bar">
                <i style={{ animationDuration: gt.req.countdown + 's', WebkitAnimationDuration: gt.req.countdown + 's' }} />
              </div>
            </div>
          ) : null}
          <div class={'pd-toast' + (toast ? ' pd-toast--on' : '') + (toastLv ? ' pd-toast--' + toastLv : '')} role="status">
            {toast}
          </div>
        </div>
      </div>
    </div>
  )
}
