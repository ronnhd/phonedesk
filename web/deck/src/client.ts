import { Soundboard, soundKey } from './sounds'
import { t } from './i18n'
import { setPlatform } from './platform'
import type { QuestionRequest, GotoReq, Notice, PushedValue, WeatherData, HassState, AiData, Layout, Media, MediaCommand, PermissionRequest, ProcInfo, Stats } from './types'

/** Connection to the PhoneDesk agent: pairing (REST) + live deck (WebSocket). No UI code here. */

export type Status = 'pair' | 'connecting' | 'online' | 'offline'

export interface ClientState {
  status: Status
  layout: Layout | null
  stats: Stats | null
  media: Media | null
  /** the last track played when nothing plays now (agent `last`, else the last one seen here); `at` = when it was last playing */
  lastMedia: Media | null
  ai: AiData | null
  /** Permission requests waiting for an answer, oldest first. */
  perms: PermissionRequest[]
  /** open Claude Code questions, oldest first */
  questions?: QuestionRequest[]
  /** Message for the pairing screen (revoked, wrong PIN, ...). */
  notice: string
  /** a reload is under way: the deck shows a veil */
  reloading?: boolean
  /** agent platform from hello: darwin | win32 | linux */
  platform?: string
  /** Home Assistant entities used by the layout (merged from full + partial updates) */
  hass?: HassState
  /** weather by item id, pushed values by key, latest notifications (newest first), pending goto countdown, theme override from a rule */
  weather?: { [itemId: string]: WeatherData }
  pushed?: { [key: string]: PushedValue }
  notes?: Notice[]
  goto?: GotoReq | null
  modeOverride?: 'dark' | 'light' | null
  /** sound id (without snd:) -> when it started and how long it is (ms, when known); phone and computer playback merged */
  sounds?: { [id: string]: { at: number; durMs?: number } }
}

export interface PressResult {
  ok: boolean
  error?: string
  data?: any
}

const K_TOKEN = 'pd.token'
const K_DEVICE = 'pd.deviceId'
const K_NAME = 'pd.name'

/** Build id of this page (meta pd-build, written by vite.config.ts); '' in dev. */
const DECK_BUILD: string = (() => {
  try {
    const m = document.querySelector('meta[name="pd-build"]')
    return (m && m.getAttribute('content')) || ''
  } catch (e) {
    return ''
  }
})()
const K_RELOAD = 'pd.reloadAt'
/**
 * One automatic reload per 2 minutes, so a build mismatch that a reload cannot fix never loops.
 * localStorage, not sessionStorage: a home-screen web app on old iOS can start a fresh session on every reload,
 * which turned the guard off and looped the page on "Reloading".
 */
function reloadAllowed(): boolean {
  try {
    const last = Number(window.localStorage.getItem(K_RELOAD) || 0)
    if (last && Date.now() - last < 120000 && last <= Date.now()) return false
    window.localStorage.setItem(K_RELOAD, String(Date.now()))
  } catch (e) {
    return false
  }
  return true
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* private mode */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  },
}

export function shortDeviceName(): string {
  const ua = navigator.userAgent || ''
  let os = 'Phone'
  if (/iPhone/.test(ua)) os = 'iPhone'
  else if (/iPad/.test(ua)) os = 'iPad'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Macintosh/.test(ua)) os = 'Mac'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Linux/.test(ua)) os = 'Linux'
  let br = ''
  if (/Edg\//.test(ua)) br = 'Edge'
  else if (/Firefox|FxiOS/.test(ua)) br = 'Firefox'
  else if (/Chrome|CriOS/.test(ua)) br = 'Chrome'
  else if (/Safari/.test(ua)) br = 'Safari'
  return br ? os + ' ' + br : os
}

export const savedDeviceName = () => store.get(K_NAME) || shortDeviceName()

interface Pending {
  resolve: (r: PressResult) => void
  timer: number
}

const asMs = (v: unknown): number => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (isFinite(t)) return t
  }
  return Date.now()
}
const toNotice = (o: any): Notice => ({
  id: String(o && o.id !== undefined ? o.id : Date.now() + Math.random()),
  title: String((o && (o.title || o.text)) || ''),
  body: o && o.body ? String(o.body) : undefined,
  level: o && (o.level === 'warn' || o.level === 'alert') ? o.level : 'info',
  at: asMs(o && (o.at || o.time)),
  ttl: o && typeof o.ttl === 'number' ? o.ttl : undefined,
})

export class DeckClient {
  private lastSeen: Media | null = null
  private helloAssets: Layout['assets'] | undefined
  private macSounds: { [id: string]: { at: number; durMs?: number } } = {}
  readonly soundboard = new Soundboard(() => this.syncSounds(), () => this.token)
  private syncSounds() {
    this.set({ sounds: Object.assign({}, this.macSounds, this.soundboard.playing) })
  }
  state: ClientState = { status: 'pair', layout: null, stats: null, media: null, lastMedia: null, ai: null, perms: [], notice: '' }
  private token: string | null = store.get(K_TOKEN)
  private ws: WebSocket | null = null
  private retry = 0
  private retryTimer = 0
  private pingTimer = 0
  private pending: { [id: string]: Pending } = {}
  private nextReq = 1
  private running = false
  private listeners: Array<(s: ClientState) => void> = []
  private base: string

  /** `baseUrl` like "http://phonedesk.local:7420" when embedded in another origin; empty = same origin. */
  constructor(baseUrl = '') {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  subscribe(fn: (s: ClientState) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }

  private set(patch: Partial<ClientState>) {
    this.state = Object.assign({}, this.state, patch)
    this.listeners.forEach((l) => l(this.state))
  }

  /** Connect (or show pairing when there is no token). Safe to call repeatedly. */
  start() {
    if (this.running) return
    this.running = true
    // no stored token: still try without ?token, the HttpOnly pd_token cookie set at pairing may authenticate; the pairing screen only
    // shows after a 4401
    this.retry = 0
    this.connect()
  }

  /** Close the socket (overlay hidden). Keeps token and layout. */
  stop() {
    this.running = false
    this.teardown()
    if (this.state.status !== 'pair') this.set({ status: 'offline' })
  }

  private origin(): string {
    return this.base || location.origin
  }

  private wsUrl(): string {
    const u = new URL(this.origin())
    const proto = u.protocol === 'https:' ? 'wss' : 'ws'
    return proto + '://' + u.host + '/ws' + (this.token ? '?token=' + encodeURIComponent(this.token) : '')
  }

  private teardown() {
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    const ws = this.ws
    if (ws) {
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.failPending(t('Disconnected'))
  }

  private connect() {
    if (!this.running) return
    clearTimeout(this.retryTimer)
    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.set({ status: 'connecting' })
    ws.onopen = () => {
      this.retry = 0
      this.set({ status: 'online' })
      clearInterval(this.pingTimer)
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 20000)
    }
    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      this.onMessage(msg)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.pingTimer)
      this.failPending(t('Disconnected'))
      if (this.state.perms.length) this.set({ perms: [] })
      if (this.state.questions && this.state.questions.length) this.set({ questions: [] })
      if (ev.code === 4401) {
        // had a token: it was revoked (say so); had none: the cookie did not authenticate, just ask for the PIN
        this.unpair(this.token ? t('This device is no longer paired. Enter the PIN again.') : '')
        return
      }
      this.set({ status: 'offline' })
      this.scheduleReconnect()
    }
    ws.onerror = () => undefined
  }

  private scheduleReconnect() {
    if (!this.running) return
    clearTimeout(this.retryTimer)
    const delay = Math.min(10000, 500 * Math.pow(2, this.retry)) + Math.random() * 300
    this.retry++
    this.retryTimer = window.setTimeout(() => this.connect(), delay)
  }

  /** Called when the page becomes visible again. */
  nudge() {
    if (this.running && this.state.status !== 'pair' && !this.ws) {
      this.retry = 0
      this.connect()
    }
  }

  private send(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj))
      return true
    }
    return false
  }

  private onMessage(msg: any) {
    switch (msg.type) {
      case 'hello':
        if (typeof msg.platform === 'string') {
          setPlatform(msg.platform)
          this.set({ platform: msg.platform })
        }
        // assets on hello (if the agent ever sends them there) are kept for the layout that follows
        if (msg.assets && typeof msg.assets === 'object') {
          this.helloAssets = msg.assets as Layout['assets']
          const cur = this.state.layout
          if (cur && !cur.assets) this.set({ layout: Object.assign({}, cur, { assets: this.helloAssets }) })
        }
        if (msg.deviceId) store.set(K_DEVICE, msg.deviceId)
        // the agent runs a newer deck than this page: reload once (guarded, never loops)
        if (typeof msg.build === 'string' && msg.build && DECK_BUILD && msg.build !== DECK_BUILD && reloadAllowed()) this.reload()
        break
      case 'reload':
        this.reload()
        break
      case 'hass': {
        const prev = this.state.hass
        const ents: { [id: string]: any } = Object.assign({}, prev ? prev.entities : {})
        const inc = msg.entities && typeof msg.entities === 'object' ? msg.entities : {}
        Object.keys(inc).forEach((id) => {
          ents[id] = inc[id] === null ? undefined : Object.assign({}, ents[id] || {}, inc[id])
          if (inc[id] === null) delete ents[id]
        })
        this.set({ hass: { entities: ents, connected: msg.connected !== false } })
        break
      }
      case 'weather': {
        const items = msg.items && typeof msg.items === 'object' ? msg.items : {}
        this.set({ weather: Object.assign({}, this.state.weather || {}, items) })
        break
      }
      case 'pushed': {
        const cur: { [k: string]: PushedValue } = Object.assign({}, this.state.pushed || {})
        const put = (key: string, x: any) => {
          if (!key) return
          if (x === null) {
            delete cur[key]
            return
          }
          const o = x && typeof x === 'object' ? x : { value: x }
          cur[key] = { value: o.value === undefined ? '' : o.value, sub: o.sub, items: Array.isArray(o.items) ? o.items : undefined, unit: o.unit, ttl: typeof o.ttl === 'number' ? o.ttl : undefined, at: asMs(o.at) }
        }
        if (msg.values && typeof msg.values === 'object') Object.keys(msg.values).forEach((k) => put(k, msg.values[k]))
        else put(String(msg.key || ''), msg.key !== undefined && msg.value !== undefined ? { value: msg.value, sub: msg.sub, unit: msg.unit, ttl: msg.ttl, at: msg.at } : msg.data)
        this.set({ pushed: cur })
        break
      }
      case 'notifications': {
        const l = Array.isArray(msg.list) ? msg.list : Array.isArray(msg.notes) ? msg.notes : []
        this.set({ notes: l.map(toNotice).sort((a: Notice, b: Notice) => b.at - a.at).slice(0, 50) })
        break
      }
      case 'notify': {
        const n = toNotice(msg.notification || msg)
        const prev = this.state.notes || []
        if (prev.some((x) => x.id === n.id)) break
        this.set({ notes: [n].concat(prev).slice(0, 50) })
        break
      }
      case 'goto': {
        const cd = typeof msg.countdown === 'number' ? Math.max(0, Math.min(60, msg.countdown)) : 3
        this.set({ goto: { id: String(msg.id || Date.now()), pageId: String(msg.pageId || msg.page || ''), countdown: cd, reason: typeof msg.reason === 'string' ? msg.reason : undefined, at: Date.now() } })
        break
      }
      case 'theme-override':
        this.set({ modeOverride: msg.mode === 'light' || msg.mode === 'dark' ? msg.mode : null })
        break
      case 'play-sound':
        if (msg.url) this.soundboard.play({ id: String(msg.id || ''), url: String(msg.url), volume: msg.volume, mode: msg.mode })
        break
      case 'stop-sounds':
        this.macSounds = {}
        this.soundboard.stopAll()
        break
      case 'sounds-playing': {
        const m: { [id: string]: { at: number; durMs?: number } } = {}
        const now = Date.now()
        ;(Array.isArray(msg.ids) ? msg.ids : []).forEach((x: any) => {
          if (typeof x === 'string') m[soundKey(x)] = this.macSounds[soundKey(x)] || { at: now }
          else if (x && x.id) m[soundKey(x.id)] = { at: typeof x.startedAt === 'number' ? now - Math.max(0, (x.positionMs || 0)) : now, durMs: typeof x.durationMs === 'number' ? x.durationMs : undefined }
        })
        this.macSounds = m
        this.syncSounds()
        break
      }
      case 'layout': {
        // The agent sends the icon assets (app icons, uploaded images, catalog and LobeHub icons) NEXT to the layout:
        // {type:'layout', layout, assets}. The renderer reads layout.assets, so attach them here.
        const layout = msg.layout as Layout
        if (layout && msg.assets && typeof msg.assets === 'object') layout.assets = msg.assets as Layout['assets']
        else if (layout && this.helloAssets) layout.assets = this.helloAssets
        this.set({ layout: layout })
        break
      }
      case 'stats':
        this.set({ stats: msg.stats as Stats })
        break
      case 'ai':
        this.set({ ai: msg.ai || null })
        break
      case 'permission': {
        const r = msg.request as PermissionRequest
        if (r && r.id && !this.state.perms.some((p) => p.id === r.id)) this.set({ perms: this.state.perms.concat([r]) })
        break
      }
      case 'question': {
        const r = msg.request as QuestionRequest
        const cur = this.state.questions || []
        if (r && r.id && Array.isArray(r.questions) && !cur.some((q) => q.id === r.id)) this.set({ questions: cur.concat([r]) })
        break
      }
      case 'question-resolved':
        this.set({ questions: (this.state.questions || []).filter((q) => q.id !== msg.id) })
        break
      case 'permission-resolved':
        this.set({ perms: this.state.perms.filter((p) => p.id !== msg.id) })
        break
      case 'processes': {
        const p = this.pending[msg.reqId]
        if (p) {
          clearTimeout(p.timer)
          delete this.pending[msg.reqId]
          p.resolve({ ok: true, data: msg.processes || [] })
        }
        break
      }
      case 'media': {
        const now = Date.now()
        if (msg.media) {
          this.lastSeen = Object.assign({}, msg.media, { playing: false, at: now })
          this.set({ media: Object.assign({}, msg.media, { at: now }), lastMedia: null })
        } else {
          const l = msg.last
          // the agent clock may differ from the phone's: only trust `at` when it is plausible
          const lat = l && typeof l.at === 'number' && l.at <= now + 60000 && now - l.at < 30 * 86400000 ? l.at : now
          this.set({ media: null, lastMedia: l && (l.title || l.artist) ? Object.assign({}, l, { playing: false, at: lat }) : this.lastSeen })
        }
        break
      }
      case 'result': {
        const p = this.pending[msg.reqId]
        if (p) {
          clearTimeout(p.timer)
          delete this.pending[msg.reqId]
          p.resolve({ ok: !!msg.ok, error: msg.error })
        }
        break
      }
      case 'pair-revoked':
        this.unpair(t('This device was removed from the computer. Pair it again.'))
        break
    }
  }

  /** Reload the page after a short veil. */
  reload() {
    if (this.state.reloading) return
    this.set({ reloading: true })
    window.setTimeout(() => {
      try {
        window.location.reload()
      } catch (e) {
        /* ignore */
      }
    }, 250)
  }

  private unpair(notice: string) {
    store.del(K_TOKEN)
    store.del(K_DEVICE)
    this.token = null
    this.teardown()
    this.set({ status: 'pair', layout: null, stats: null, media: null, lastMedia: null, ai: null, perms: [], questions: [], notice, hass: undefined, weather: undefined, pushed: undefined, notes: undefined, goto: null, modeOverride: null })
  }

  private failPending(error: string) {
    const ids = Object.keys(this.pending)
    ids.forEach((id) => {
      const p = this.pending[id]
      clearTimeout(p.timer)
      p.resolve({ ok: false, error })
    })
    this.pending = {}
  }

  /** Send a request that gets a `result` reply (press, media, volume). Resolves with the agent's result. */
  request(body: { [k: string]: unknown }): Promise<PressResult> {
    return new Promise((resolve) => {
      const reqId = 'r' + this.nextReq++
      if (!this.send(Object.assign({}, body, { reqId }))) {
        resolve({ ok: false, error: t('Not connected') })
        return
      }
      const timer = window.setTimeout(() => {
        delete this.pending[reqId]
        resolve({ ok: false, error: t('No response') })
      }, 15000)
      this.pending[reqId] = { resolve, timer }
    })
  }

  press(pageId: string, itemId: string): Promise<PressResult> {
    return this.request({ type: 'press', pageId, itemId })
  }
  /** Answer a Claude Code question: answers {questionText: label | typed text}, other {questionText: true} for typed text; release hands it back to the terminal. */
  answerQuestion(id: string, body: { answers?: { [q: string]: string }; other?: { [q: string]: boolean }; choices?: { [q: string]: string[] }; custom?: { [q: string]: string }; release?: boolean }): Promise<PressResult> {
    const req: { [k: string]: unknown } = { type: 'question-answer', id }
    if (body.release) req.release = true
    else {
      req.answers = body.answers || {}
      if (body.other && Object.keys(body.other).length) req.other = body.other
      // exact labels (not joined with commas) and the typed answer, for OpenCode's [[label...]...] reply
      if (body.choices) req.choices = body.choices
      if (body.custom && Object.keys(body.custom).length) req.custom = body.custom
    }
    return this.request(req).then((r) => {
      if (r.ok) this.set({ questions: (this.state.questions || []).filter((q) => q.id !== id) })
      return r
    })
  }
  answerPermission(id: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always' = 'once'): Promise<PressResult> {
    return this.request({ type: 'permission-answer', id, decision, scope }).then((r) => {
      if (r.ok) this.set({ perms: this.state.perms.filter((p) => p.id !== id) })
      return r
    })
  }
  processes(sort: 'cpu' | 'mem', limit = 30): Promise<{ ok: boolean; error?: string; list: ProcInfo[] }> {
    return this.request({ type: 'processes', sort, limit }).then((r) => ({ ok: r.ok, error: r.error, list: (r.data as ProcInfo[]) || [] }))
  }
  media(command: MediaCommand, app?: string): Promise<PressResult> {
    return this.request(app ? { type: 'media', command, app } : { type: 'media', command })
  }
  volume(v: { level: number } | { muted: boolean }): Promise<PressResult> {
    return this.request(Object.assign({ type: 'volume' }, v))
  }

  /** Exchange the PIN for a token. Rejects with a readable message. */
  async pair(pin: string, name: string): Promise<void> {
    const res = await fetch(this.base + '/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: pin.trim(), name }),
    })
    let data: any = {}
    try {
      data = await res.json()
    } catch {
      /* not json */
    }
    if (!res.ok || !data.token) throw new Error(data.error || t('Pairing failed ({0})', res.status))
    store.set(K_TOKEN, data.token)
    store.set(K_DEVICE, data.deviceId || '')
    store.set(K_NAME, name)
    this.token = data.token
    this.set({ notice: '' })
    this.running = false
    this.start()
  }
}

