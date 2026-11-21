import { useEffect, useState } from 'preact/hooks'
import { getLang } from './i18n'
import { t } from './i18n'
import { TileIcon } from './icon'
import { isIconName } from '../../shared/icons'
import { convTemp, tempUnit, unitOf } from './temp'
import { OmniPet } from './omni-pet'
import type { IconAssets, Notice, PushedValue, PushOptions, WeatherData, WeatherOptions } from './types'

/** Re-render every `ms` so relative times ("3 min ago") stay fresh. */
export function useTick(ms: number): number {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}

export function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return t('just now')
  if (s < 60) return t('{0}s ago', s)
  const m = Math.round(s / 60)
  if (m < 60) return t('{0} min ago', m)
  const h = Math.round(m / 60)
  if (h < 24) return t('{0}h ago', h)
  return t('{0}d ago', Math.round(h / 24))
}

const toMs = (v: unknown): number => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return isFinite(t) ? t : Date.now()
  }
  return Date.now()
}
export const atOf = toMs

// ---------------- weather ----------------

type Cond = 'clear' | 'night' | 'partly' | 'cloudy' | 'rain' | 'pour' | 'storm' | 'snow' | 'fog' | 'wind' | 'hail'
/** Accepts Home Assistant weather states, Open-Meteo style words and WMO codes. */
export function condOf(c: unknown): Cond {
  if (typeof c === 'number') {
    if (c === 0 || c === 1) return 'clear'
    if (c === 2) return 'partly'
    if (c === 3) return 'cloudy'
    if (c === 45 || c === 48) return 'fog'
    if ((c >= 51 && c <= 57) || c === 61 || c === 80) return 'rain'
    if (c === 63 || c === 65 || c === 66 || c === 67 || c === 81 || c === 82) return 'pour'
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow'
    if (c >= 95) return 'storm'
    return 'cloudy'
  }
  const s = String(c || '').toLowerCase()
  if (s.indexOf('night') >= 0) return 'night'
  if (s.indexOf('partly') >= 0 || s.indexOf('mainly') >= 0) return 'partly'
  if (s.indexOf('pour') >= 0 || s.indexOf('heavy') >= 0) return 'pour'
  if (s.indexOf('light') >= 0 && s.indexOf('ning') >= 0) return 'storm'
  if (s.indexOf('storm') >= 0 || s.indexOf('thunder') >= 0) return 'storm'
  if (s.indexOf('hail') >= 0) return 'hail'
  if (s.indexOf('snow') >= 0 || s.indexOf('sleet') >= 0) return 'snow'
  if (s.indexOf('rain') >= 0 || s.indexOf('drizzle') >= 0 || s.indexOf('shower') >= 0) return 'rain'
  if (s.indexOf('fog') >= 0 || s.indexOf('mist') >= 0 || s.indexOf('haze') >= 0) return 'fog'
  if (s.indexOf('wind') >= 0) return 'wind'
  if (s.indexOf('cloud') >= 0 || s.indexOf('overcast') >= 0) return 'cloudy'
  if (s.indexOf('sun') >= 0 || s.indexOf('clear') >= 0) return 'clear'
  return 'cloudy'
}
const COND_TEXT: { [k in Cond]: string } = { clear: 'Clear', night: 'Clear', partly: 'Partly cloudy', cloudy: 'Cloudy', rain: 'Rain', pour: 'Heavy rain', storm: 'Thunderstorm', snow: 'Snow', fog: 'Fog', wind: 'Windy', hail: 'Hail' }
/** Tabler names first (drawn when built in or shipped in layout.assets), emoji when they are not. */
const COND_ICON: { [k in Cond]: { names: string[]; emoji: string; color: string } } = {
  clear: { names: ['sun'], emoji: '☀️', color: '#fbbf24' },
  night: { names: ['moon'], emoji: '🌙', color: '#a5b4fc' },
  partly: { names: ['cloud-sun', 'sun'], emoji: '⛅', color: '#fbbf24' },
  cloudy: { names: ['cloud'], emoji: '☁️', color: '#9ca3af' },
  rain: { names: ['cloud-rain'], emoji: '🌧️', color: '#60a5fa' },
  pour: { names: ['cloud-rain'], emoji: '🌧️', color: '#3b82f6' },
  storm: { names: ['cloud-storm', 'bolt'], emoji: '⛈️', color: '#a78bfa' },
  snow: { names: ['snowflake'], emoji: '❄️', color: '#bae6fd' },
  fog: { names: ['cloud-fog'], emoji: '🌫️', color: '#9ca3af' },
  wind: { names: ['wind'], emoji: '💨', color: '#9ca3af' },
  hail: { names: ['cloud-snow', 'cloud-rain'], emoji: '🌨️', color: '#bae6fd' },
}
/** Names the weather widget can draw; the orchestrator's gen-assets should include them. */
export const WEATHER_ICON_NAMES = ['sun', 'moon', 'cloud', 'cloud-sun', 'cloud-rain', 'cloud-storm', 'cloud-snow', 'cloud-fog', 'snowflake', 'wind', 'bolt']

function WxGlyph(props: { cond: unknown; size: number; assets?: IconAssets }) {
  const c = COND_ICON[condOf(props.cond)]
  let name = ''
  for (let i = 0; i < c.names.length; i++) {
    if (isIconName(c.names[i]) || (props.assets && Object.prototype.hasOwnProperty.call(props.assets, c.names[i]))) {
      name = c.names[i]
      break
    }
  }
  return (
    <span class="pd-wx__g" style={{ color: c.color, width: props.size + 'px', height: props.size + 'px', fontSize: Math.round(props.size * 0.8) + 'px', lineHeight: props.size + 'px' }}>
      {name ? <TileIcon value={name} size={props.size} assets={props.assets} /> : c.emoji}
    </span>
  )
}

const DAY_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY = (): string[] => (getLang() === 'vi' ? DAY_VI : DAY_EN)
const degIn = (n: number | undefined, from: 'C' | 'F', to: 'C' | 'F') => (typeof n === 'number' && isFinite(n) ? Math.round(convTemp(n, from, to)) + '°' : '–')
const SOURCE_NAME: { [k: string]: string } = { hass: 'Home Assistant', 'open-meteo': 'Open-Meteo' }
/** low-opacity, condition tinted wash behind the tile (brand-safe tones, fine on light and dark) */
const COND_TINT: { [k in Cond]: string } = {
  clear: '251,191,36',
  night: '99,102,241',
  partly: '251,191,36',
  cloudy: '148,163,184',
  rain: '59,130,246',
  pour: '59,130,246',
  storm: '99,102,241',
  snow: '186,230,253',
  fog: '148,163,184',
  wind: '148,163,184',
  hail: '186,230,253',
}
const isNightAt = (ms: number) => {
  const h = new Date(ms).getHours()
  return h >= 19 || h < 6
}
/** condition with the sun swapped for the moon after dark */
const condAt = (c: unknown, ms: number): Cond => {
  const k = condOf(c)
  return k === 'clear' && isNightAt(ms) ? 'night' : k
}
const hourLabel = (ms: number) => {
  const h = new Date(ms).getHours()
  return getLang() === 'vi' ? h + 'h' : (h % 12 || 12) + (h < 12 ? ' AM' : ' PM')
}

export interface WeatherProps {
  opts?: WeatherOptions
  data?: WeatherData
  tw: number
  th: number
  /** grid span of the tile in cells; the face is picked from it first */
  cw?: number
  ch?: number
  scale: number
  showLabel: boolean
  textColor?: string
  assets?: IconAssets
}

/**
 * Layout by size (px of the tile):
 *   tiny    1x1            glyph + temperature
 *   row     2x1            glyph, temperature, condition, H/L
 *   card    2x2            place + glyph, big temperature, condition, H/L, hourly strip
 *   wide    3x1 / 4x1      current on the left, hourly strip on the right
 *   full    3x2 / 4x2      current block, hourly strip, daily rows with min/max bars
 *   tall    2x3            daily list (current as a slim header)
 */
export function WeatherTile(props: WeatherProps) {
  const now = useTick(30000)
  const d = props.data
  const tw = props.tw
  const th = props.th
  const pad = tw >= 170 ? 14 : 10
  const col = props.textColor || undefined
  if (!d || !d.now) {
    return (
      <div class="pd-wx pd-wx--empty" style={{ padding: pad + 'px' }}>
        <WxGlyph cond="cloudy" size={Math.round(Math.min(34, th * 0.35))} assets={props.assets} />
        <span class="pd-wx__s">{t('Loading weather…')}</span>
      </div>
    )
  }
  const cur = d.now
  // shown unit: the widget's own units win over the theme; the source unit is what the numbers are in (open-meteo is requested in the shown unit)
  const toU: 'C' | 'F' = props.opts && props.opts.units ? (props.opts.units === 'imperial' ? 'F' : 'C') : tempUnit()
  const fromU: 'C' | 'F' = d.unit ? unitOf(d.unit) : d.source === 'open-meteo' ? toU : 'C'
  const deg = (n: number | undefined) => degIn(n, fromU, toU)
  const show = (props.opts && props.opts.show) || 'auto'
  const hourly = (d.hourly || []).slice(0, 12)
  const daily = (d.daily || []).slice(0, 7)
  const innerW = tw - pad * 2
  const innerH = th - pad * 2
  const place = d.location || (props.opts && props.opts.location && props.opts.location.name) || ''
  const hi = cur.high !== undefined ? cur.high : daily[0] ? daily[0].high : undefined
  const lo = cur.low !== undefined ? cur.low : daily[0] ? daily[0].low : undefined
  const cond = condAt(cur.condition, now)
  const ageMin = d.updatedAt ? Math.round((now - toMs(d.updatedAt)) / 60000) : 0
  const stale = ageMin > 45
  const condText = cur.text || t(COND_TEXT[cond])
  const hl = hi !== undefined || lo !== undefined ? 'H:' + deg(hi) + '  L:' + deg(lo) : ''

  // mode
  // face by grid span first (cw x ch cells); pixels only decide for very small tiles
  const cw = props.cw || Math.max(1, Math.round(tw / 140))
  const ch = props.ch || Math.max(1, Math.round(th / 140))
  let mode: 'tiny' | 'row' | 'card' | 'wide' | 'full' | 'tall' = 'card'
  if (ch <= 1) mode = cw <= 1 ? 'tiny' : cw === 2 ? 'row' : 'wide'
  else if (cw <= 1) mode = 'tall'
  else if (cw === 2) mode = ch >= 3 ? 'tall' : 'card'
  else mode = 'full'
  if (tw < 100 || th < 70) mode = 'tiny'
  if (show === 'daily' && th >= 100) mode = ch <= 1 ? (cw >= 3 ? 'wide' : 'row') : cw >= 3 ? 'full' : 'tall'
  if (show === 'hourly' && th >= 100 && (mode === 'full' || mode === 'tall')) mode = cw >= 3 && ch <= 2 ? 'wide' : 'card'
  const noStrip = show === 'now'
  if (noStrip && (mode === 'full' || mode === 'wide' || mode === 'tall')) mode = ch <= 1 ? 'row' : 'card'

  const temp = (size: number) => (
    <span class="pd-wx__t" style={{ fontSize: size + 'px', color: col }}>
      {deg(cur.temp)}
    </span>
  )

  const hourEls = (n: number, big: boolean) => {
    const list = hourly.slice(0, n)
    if (!list.length) return null
    return (
      <div class={'pd-wx__hr' + (big ? ' pd-wx__hr--big' : '')}>
        {list.map((h, i) => {
          const ms = toMs(h.t)
          return (
            <span class="pd-wx__h" key={i}>
              <span class="pd-wx__hl">{i === 0 ? t('Now') : hourLabel(ms)}</span>
              <WxGlyph cond={condAt(h.condition, ms)} size={big ? 24 : 20} assets={props.assets} />
              <b style={{ color: col }}>{deg(h.temp)}</b>
            </span>
          )
        })}
      </div>
    )
  }

  const dailyEls = (n: number, rh?: number) => {
    const list = daily.slice(0, n)
    if (!list.length) return null
    let min = Infinity
    let max = -Infinity
    daily.forEach((x) => {
      if (x.low < min) min = x.low
      if (x.high > max) max = x.high
    })
    const span = Math.max(1, max - min)
    return (
      <div class="pd-wx__dy">
        {list.map((x, i) => {
          const l = ((x.low - min) / span) * 100
          const w = Math.max(8, ((x.high - x.low) / span) * 100)
          return (
            <span class="pd-wx__d" key={i} style={rh ? { height: rh + 'px' } : undefined}>
              <span class="pd-wx__dn">{i === 0 ? t('Today') : DAY()[new Date(toMs(x.t)).getDay()]}</span>
              <WxGlyph cond={x.condition} size={20} assets={props.assets} />
              <span class="pd-wx__lo">{deg(x.low)}</span>
              <span class="pd-wx__bar">
                <i style={{ left: l + '%', width: Math.min(100 - l, w) + '%' }} />
              </span>
              <span class="pd-wx__hi" style={{ color: col }}>{deg(x.high)}</span>
            </span>
          )
        })}
      </div>
    )
  }

  /** place (small, top-left) with the glyph top-right; temperature; condition; H/L */
  const currentBlock = (bigT: number, gl: number, compact?: boolean) =>
    compact ? (
      <div class="pd-wx__cur">
        <div class="pd-wx__slim">
          <WxGlyph cond={cond} size={gl} assets={props.assets} />
          {temp(bigT)}
        </div>
        <span class="pd-wx__s pd-wx__c" style={{ color: col }}>{condText}</span>
      </div>
    ) : (
      <div class="pd-wx__cur">
        <div class="pd-wx__top">
          <span class="pd-wx__place">{place}</span>
          <WxGlyph cond={cond} size={gl} assets={props.assets} />
        </div>
        {temp(bigT)}
        <span class="pd-wx__s pd-wx__c" style={{ color: col }}>{condText}</span>
        {hl ? <span class="pd-wx__s">{hl}</span> : null}
      </div>
    )

  let body: any = null
  if (mode === 'tiny') {
    // one key: glyph about 38% of the tile with the temperature under it, centred as a group; H/L only when it fits
    const m = Math.min(tw, th)
    const gl = Math.round(Math.max(22, m * 0.38))
    const tsz = Math.round(Math.max(20, Math.min(m * 0.27, innerW * 0.34)))
    const showHl = !!hl && innerH >= gl + tsz + 30 && innerW >= 76
    body = (
      <div class="pd-wx__tiny">
        <WxGlyph cond={cond} size={gl} assets={props.assets} />
        {temp(tsz)}
        {showHl ? <span class="pd-wx__hl1">{'H ' + deg(hi).replace('°', '') + ' · L ' + deg(lo).replace('°', '')}</span> : null}
      </div>
    )
  } else if (mode === 'row') {
    const bigT = Math.round(Math.max(24, Math.min(44, innerH * 0.56, innerW * 0.13)))
    body = (
      <div class="pd-wx__rowm">
        <WxGlyph cond={cond} size={Math.round(Math.min(40, innerH * 0.62))} assets={props.assets} />
        {temp(bigT)}
        <span class="pd-wx__rt">
          <span class="pd-wx__s pd-wx__c" style={{ color: col }}>{condText}</span>
          {hl ? <span class="pd-wx__s">{hl}</span> : null}
        </span>
      </div>
    )
  } else if (mode === 'card') {
    // 2x2: place + glyph, big temperature, condition, H/L, then a 4-5 slot hourly strip (type shrinks to fit)
    const strip = !noStrip && innerH >= 130 && hourly.length > 0
    const slots = Math.max(3, Math.min(5, Math.floor(innerW / 40)))
    const bigT = Math.round(Math.max(26, Math.min(56, strip ? innerH - 138 : innerH * 0.36, innerW * 0.3)))
    body = (
      <>
        {currentBlock(bigT, Math.round(Math.min(34, Math.max(22, bigT * 0.75))), innerH < 110)}
        {strip ? hourEls(slots, false) : null}
      </>
    )
  } else if (mode === 'wide') {
    const compact = innerH < 120
    const slots = Math.max(3, Math.min(8, Math.floor((innerW * 0.58) / 46)))
    const bigT = Math.round(Math.max(28, Math.min(52, compact ? innerH * 0.5 : innerH * 0.34)))
    body = (
      <div class="pd-wx__split">
        <div class="pd-wx__sl">{currentBlock(bigT, 30, compact)}</div>
        <div class="pd-wx__sr">{hourEls(slots, false)}</div>
      </div>
    )
  } else if (mode === 'full') {
    const compact = innerH < 215
    const slots = Math.max(4, Math.min(9, Math.floor(innerW / 54)))
    const bigT = compact ? 34 : 44
    const used = compact ? 78 : bigT + 56
    const rh = compact ? 24 : 28
    const rows = Math.max(1, Math.min(th >= 300 ? 4 : 3, daily.length, Math.floor((innerH - used - (compact ? 4 : 32)) / rh)))
    body = (
      <>
        <div class="pd-wx__split pd-wx__split--top">
          <div class="pd-wx__sl">{currentBlock(bigT, 30, compact)}</div>
          <div class="pd-wx__sr">{hourEls(slots > 6 && tw < 400 ? 5 : Math.min(slots, 6), false)}</div>
        </div>
        {dailyEls(rows, rh)}
      </>
    )
  } else {
    // tall / daily: slim current header, then 4+ days with min-max bars
    const small = innerH < 215
    const rh = small ? 24 : 28
    const rows = Math.max(small ? 4 : 3, Math.min(7, daily.length, Math.floor((innerH - (small ? 54 : 70)) / rh)))
    body = (
      <>
        <div class="pd-wx__slim">
          <WxGlyph cond={cond} size={small ? 24 : 34} assets={props.assets} />
          {temp(small ? 28 : 40)}
          <span class="pd-wx__rt">
            <span class="pd-wx__s pd-wx__c" style={{ color: col }}>{condText}</span>
            {place ? <span class="pd-wx__s">{place}</span> : null}
          </span>
        </div>
        {dailyEls(Math.min(rows, daily.length), rh)}
      </>
    )
  }

  const src = d.source ? SOURCE_NAME[d.source] || d.source : ''
  const showSrc = src && ((mode === 'full' && innerH >= 215) || (mode === 'tall' && th >= 330))
  return (
    <div class={'pd-wx pd-wx--' + mode + (stale ? ' pd-wx--stale' : '')} style={{ padding: pad + 'px', background: mode === 'tiny' ? 'rgba(' + COND_TINT[cond] + ',0.12)' : 'linear-gradient(160deg, rgba(' + COND_TINT[cond] + ',0.17), rgba(' + COND_TINT[cond] + ',0.03) 75%)', borderRadius: 'inherit' }}>
      {body}
      {showSrc ? (
        <span class="pd-wx__src">
          {src}
          {stale ? ' · ' + t('{0} min ago', ageMin) : ''}
        </span>
      ) : null}
    </div>
  )
}

// ---------------- pushed value ----------------

export interface ValueProps {
  cfg: PushOptions
  val?: PushedValue
  petVal?: PushedValue
  tw: number
  th: number
  scale: number
  showLabel: boolean
  color?: string
  textColor?: string
}

export function ValueTile(props: ValueProps) {
  const now = useTick(15000)
  const v = props.val
  const tw = props.tw
  const th = props.th
  const pad = tw >= 170 ? 14 : 10
  const label = props.cfg.label || props.cfg.key
  const stale = !!v && typeof v.ttl === 'number' && v.ttl > 0 && now - v.at > v.ttl * 1000
  const text = v ? String(v.value) : '–'
  const unit = props.cfg.unit || (v && v.unit) || ''
  const len = (text + unit).length
  const withPet = !!props.cfg.pet && tw >= 150 && th >= 70
  const vs = Math.max(16, Math.min(Math.floor(th * (v && v.sub ? 0.34 : 0.42)), Math.floor((tw - pad * 2 - (withPet ? 34 : 0)) / (Math.max(2, len) * 0.56)), 56))
  const col = props.textColor || props.color || undefined
  return (
    <div class={'pd-vl' + (stale ? ' pd-vl--stale' : '') + (withPet ? ' pd-vl--pet' : '')} style={{ padding: pad + 'px' }}>
      <span class="pd-vl__lb" style={{ color: props.color || undefined }}>
        {label}
      </span>
      <span class="pd-vl__v" style={{ fontSize: vs + 'px', color: col }}>
        {text}
        {unit ? <i style={{ fontSize: Math.max(10, Math.round(vs * 0.42)) + 'px' }}>{unit}</i> : null}
      </span>
      {withPet ? <OmniPet val={props.petVal} size={Math.max(24, Math.min(40, Math.floor(th * 0.34)))} /> : null}
      {v && v.sub && th >= 80 ? <span class="pd-vl__sub">{v.sub}</span> : null}
      <span class="pd-vl__t">{v ? (stale ? t('Stale') + ' · ' : '') + relTime(v.at, now) : t('No data yet')}</span>
    </div>
  )
}

// ---------------- notifications ----------------

export const LEVEL_COLOR: { [k: string]: string } = { info: '#60a5fa', warn: '#f59e0b', alert: '#f87171' }

export function NotificationsTile(props: { notes: Notice[]; tw: number; th: number; showLabel: boolean; textColor?: string }) {
  const now = useTick(20000)
  const pad = props.tw >= 170 ? 14 : 10
  const rows = Math.max(1, Math.floor((props.th - pad * 2 - (props.showLabel ? 20 : 0)) / 38))
  const list = props.notes.filter((n) => !n.ttl || now - n.at < n.ttl * 1000).slice(0, rows)
  return (
    <div class="pd-nt" style={{ padding: pad + 'px' }}>
      {props.showLabel ? <span class="pd-nt__h">{t('Notifications')}</span> : null}
      {list.length === 0 ? <span class="pd-nt__e">{t('No notifications')}</span> : null}
      {list.map((n) => (
        <div class="pd-nt__r" key={n.id}>
          <i class="pd-nt__d" style={{ background: LEVEL_COLOR[n.level || 'info'] || LEVEL_COLOR.info }} />
          <span class="pd-nt__b">
            <span class="pd-nt__t" style={{ color: props.textColor || undefined }}>{n.title}</span>
            {n.body && props.th >= 130 ? <span class="pd-nt__s">{n.body}</span> : null}
          </span>
          <span class="pd-nt__a">{relTime(n.at, now)}</span>
        </div>
      ))}
    </div>
  )
}
