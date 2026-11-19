import { QuotaWidget, SessionsWidget } from './ai'
import { t } from './i18n'
import { getPlatform } from './platform'
import type { AiWidgetProps } from './ai'
import { Rings, SlotSpark } from './charts'
import { BarSpark, Donut, MeterBar, windowSeries } from './metric-charts'
import { NowPlayingTile } from './now-playing'
import { PolyLiveTile } from './polymarket'
import { ClockWidget } from './clocks'
import { EntityTile } from './entity'
import { NotificationsTile, ValueTile, WeatherTile } from './automation'
import { AnimatedNumber, BAND_COLOR, DeltaPill, Gauge, type Band } from './knowns'
import { tint } from './theme'
import type { AiData, ClockOptions, MetricOptions, QuotaOptions, EntityOptions, WeatherOptions, PushOptions, WeatherData, PushedValue, Notice, HassEntity, IconAssets, Media, MediaCommand, Stats, WidgetKind } from './types'

/** Live widgets: clock, cpu, memory, network, load, uptime, nowplaying. Sizes come from the tile (tw/th in px). */

export interface Hist {
  cpu: number[]
  mem: number[]
  rx: number[]
  tx: number[]
  load: number[]
}

/** ~15 min of 2 s samples (the longest chart window); charts downsample to their slot count */
export const HIST_LEN = 450

const GB = 1024 * 1024 * 1024

export const DEFAULT_COLOR: { [k: string]: string } = {
  cpu: '#2dd4bf',
  memory: '#f472b6',
  network: '#f59e0b',
  load: '#34d399',
  uptime: '#60a5fa',
  clock: '#8b8b94',
}
const LABEL: { [k: string]: string } = {
  clock: 'Clock',
  cpu: 'CPU',
  memory: 'RAM',
  network: 'Network',
  load: 'System load',
  uptime: 'Uptime',
}

/** Font size (px) that keeps `chars` characters inside `avail` px (no clamp()/container queries on Safari 12). */
const fit = (chars: number, avail: number, max: number, min: number) => Math.max(min, Math.min(max, Math.floor(avail / (Math.max(1, chars) * 0.62))))

/** bytes/s -> ["7.9", "MB/s"] */
export function fmtRate(bps: number): [string, string] {
  const v = Math.max(0, bps || 0)
  if (v >= 1024 * 1024 * 1024) return [(v / (1024 * 1024 * 1024)).toFixed(1), 'GB/s']
  if (v >= 1024 * 1024) return [(v / (1024 * 1024)).toFixed(1), 'MB/s']
  if (v >= 1024) return [Math.round(v / 1024) + '', 'KB/s']
  return [Math.round(v) + '', 'B/s']
}
const fmtRateStr = (bps: number) => fmtRate(bps).join(' ')

function fmtUptime(s: number, compact: boolean) {
  s = Math.max(0, Math.floor(s))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (compact) return d > 0 ? d + 'd' : h > 0 ? h + 'h' : m + 'm'
  return d > 0 ? d + 'd ' + h + 'h' : h + 'h ' + m + 'm'
}

export interface WidgetProps {
  kind: WidgetKind | string
  stats: Stats | null
  hist: Hist
  media: Media | null
  last: Media | null
  tw: number
  th: number
  /** grid span (cells) */
  cw?: number
  ch?: number
  scale: number
  showLabel: boolean
  /** item.color: tints the label and sparkline (widgets keep a neutral tile background) */
  color?: string
  /** item.textColor override */
  textColor?: string
  provider?: string
  clock?: ClockOptions
  metric?: MetricOptions
  quota?: QuotaOptions
  entity?: EntityOptions
  weather?: WeatherOptions
  push?: PushOptions
  wxData?: WeatherData
  pushed?: PushedValue
  notes?: Notice[]
  hassEnt?: HassEntity
  hassForceOn?: boolean
  entPend?: number
  onStep?: (delta: number) => void
  onLight?: (op: string, value: unknown) => void
  hassConnected?: boolean
  assets?: IconAssets
  ai: AiData | null
  waitingProjects: string[]
  preview: boolean
  onMedia: (c: MediaCommand, app?: string) => Promise<unknown> | void
  onVolume: (v: { level: number } | { muted: boolean }) => Promise<unknown> | void
}

export function Widget(props: WidgetProps) {
  if (props.kind === 'clock') return <ClockWidget tw={props.tw} th={props.th} scale={props.scale} showLabel={props.showLabel} textColor={props.textColor} color={props.color} opts={props.clock} caption={LABEL.clock} />
  if (props.kind === 'entity' && props.entity) return <EntityTile id={props.entity.id} cfg={props.entity} ent={props.hassEnt} forceOn={props.hassForceOn} pend={props.entPend} onStep={props.onStep} onLight={props.onLight} connected={props.hassConnected !== false} tw={props.tw} th={props.th} scale={props.scale} showLabel={props.showLabel} color={props.color} textColor={props.textColor} assets={props.assets} />
  if (props.kind === 'weather') return <WeatherTile opts={props.weather} data={props.wxData} tw={props.tw} th={props.th} cw={props.cw} ch={props.ch} scale={props.scale} showLabel={props.showLabel} textColor={props.textColor} assets={props.assets} />
  if (props.kind === 'value' && props.push) return <ValueTile cfg={props.push} val={props.pushed} tw={props.tw} th={props.th} scale={props.scale} showLabel={props.showLabel} color={props.color} textColor={props.textColor} />
  if (props.kind === 'polymarket') return <PolyLiveTile cfg={props.push} val={props.pushed} tw={props.tw} th={props.th} color={props.color} textColor={props.textColor} showLabel={props.showLabel} />
  if (props.kind === 'notifications') return <NotificationsTile notes={props.notes || []} tw={props.tw} th={props.th} showLabel={props.showLabel} textColor={props.textColor} />
  if (props.kind === 'nowplaying') return <NowPlayingTile media={props.media} last={props.last} stats={props.stats} tw={props.tw} th={props.th} scale={props.scale} showLabel={props.showLabel} textColor={props.textColor} onMedia={props.onMedia} onVolume={props.onVolume} />
  if (props.kind === 'quota') return <QuotaWidget {...(props as AiWidgetProps)} />
  if (props.kind === 'sessions') return <SessionsWidget {...(props as AiWidgetProps)} />
  return <Metric {...props} />
}


/** First vs last sample of the history (~1 minute at one sample a second). */
const deltaOf = (a: number[]): number | null => {
  const r = a.slice(-30)
  return r.length >= 8 ? r[r.length - 1] - r[0] : null
}

/** cpu < 60 good, < 85 watch, else risk (agent-health-utils.ts: statusFromThresholds with lower-is-better cuts). */
const cpuBand = (v: number): Band => (v < 60 ? 'good' : v < 85 ? 'watch' : 'risk')
const LOAD_LABEL: { [k: string]: string } = { loadavg: 'System load', queue: 'CPU queue', estimate: 'Load (est.)' }
/** stats.loadKind (also accepted as stats.load.kind) */
const loadKindOf = (s: Stats | null): string => (s ? s.loadKind || ((s.load as unknown as { kind?: string }) || {}).kind || '' : '')
const BAND_TEXT: { [k: string]: string } = { good: 'Normal', watch: 'Elevated', risk: 'Overloaded' }

/**
 * cpu / memory / load / network / uptime. Look of Knowns UI live-metrics.tsx (MetricCard number + DeltaPill + Chart line with
 * slots and endDot). Network uses the same Sparkline with a thin tx line on a shared scale; a big cpu tile uses the agent-health gauge.
 */
function Metric(props: WidgetProps) {
  const s = props.stats
  const kind = props.kind
  const color = props.color || DEFAULT_COLOR[kind] || '#8b8b94'
  const compact = props.tw < 120
  const roomy = props.tw >= 170 && props.th >= 100
  let num = 0
  let fmt: (n: number) => string = (n) => String(Math.round(n))
  let unit = ''
  let sub = ''
  let data: number[] | null = null
  let max: number | undefined
  let delta: { v: number; unit: string; dec: number; tone?: 'warn' | 'bad' } | null = null
  if (s) {
    if (kind === 'cpu') {
      num = Math.round(s.cpu)
      unit = '%'
      data = props.hist.cpu
      max = 100
      const d = deltaOf(props.hist.cpu)
      if (d !== null) delta = { v: d, unit: '%', dec: 0, tone: d >= 20 ? 'bad' : undefined }
    } else if (kind === 'memory') {
      num = s.memUsed / GB
      fmt = (n) => n.toFixed(1)
      unit = 'GB'
      sub = '/ ' + Math.round(s.memTotal / GB) + ' GB'
      data = props.hist.mem
      max = 100
      const d = deltaOf(props.hist.mem)
      if (d !== null) {
        const g = (d / 100) * (s.memTotal / GB)
        delta = { v: g, unit: ' GB', dec: 1, tone: g >= 1 ? 'warn' : undefined }
      }
    } else if (kind === 'network') {
      const r = fmtRate(s.net ? s.net.rx : 0)
      num = parseFloat(r[0])
      const dec = r[0].indexOf('.') >= 0 ? 1 : 0
      fmt = (n) => n.toFixed(dec)
      unit = r[1]
      data = props.hist.rx
    } else if (kind === 'load') {
      const l = s.load || []
      num = Number(l[0] || 0)
      const dec = compact ? 1 : 2
      fmt = (n) => n.toFixed(dec)
      sub = Number(l[1] || 0).toFixed(1) + ' / ' + Number(l[2] || 0).toFixed(1)
      data = props.hist.load
      const d = deltaOf(props.hist.load)
      // a Windows agent without a load kind that always reports 0 has nothing to compare: no flat delta pill
      const flatZero = !loadKindOf(s) && getPlatform() === 'win32' && props.hist.load.every((v) => v === 0)
      if (d !== null && !flatZero) delta = { v: d, unit: '', dec: 2 }
    } else if (kind === 'uptime') {
      num = s.uptime
      fmt = (n) => fmtUptime(n, compact)
    }
  }
  const label = (kind === 'load' ? t(LOAD_LABEL[loadKindOf(s) || 'loadavg'] || 'System load') : LABEL[kind] ? t(LABEL[kind]) : String(kind)).toUpperCase()
  const pad = props.tw >= 170 ? 16 : props.tw >= 120 ? 12 : 8
  const avail = Math.max(20, props.tw - pad * 2)

  // ----- chart choice (item.metric): defaults cpu gauge on square-ish tiles, else sparkline -----
  const mo = props.metric || {}
  const pctKind = kind === 'cpu' || kind === 'memory'
  const pct = !s ? 0 : kind === 'cpu' ? s.cpu : kind === 'memory' && s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0
  const base = kind === 'cpu' && props.tw >= 140 && props.th >= 140 ? 'gauge' : 'sparkline'
  let chart: string = mo.chart || base
  if (!pctKind && (chart === 'gauge' || chart === 'ring' || chart === 'bar' || chart === 'donut')) chart = base
  if (kind === 'cpu' && chart === 'donut') chart = 'ring'
  if (kind === 'uptime') chart = 'number'
  const showDeltaOpt = mo.showDelta !== false
  const showSubOpt = mo.showSub !== false
  const winSec = mo.window || 120
  const tc0 = props.textColor || undefined
  const lh = props.showLabel ? 16 : 0
  const band = cpuBand(pct)
  const labelEl = props.showLabel ? (
    <div class="pd-ml" style={{ fontSize: '11px', color: props.textColor || color }}>
      {label}
    </div>
  ) : null
  const deltaEl = (size: number) => (delta && showDeltaOpt ? <DeltaPill value={delta.v} unit={delta.unit} decimals={delta.dec} tone={delta.tone} size={size} /> : null)
  const bigNum = (size: number) => (
    <div class="pd-mv" style={{ fontSize: size + 'px', color: tc0 }}>
      <AnimatedNumber value={num} format={fmt} />
      {unit ? <span class="pd-mu" style={{ fontSize: Math.max(9, Math.round(size * 0.42)) + 'px' }}>{' ' + unit}</span> : null}
    </div>
  )

  // gauge: agent-health arc
  if (chart === 'gauge' && s) {
    const sparkRoom = props.th >= 210 && data && kind === 'cpu' ? 40 : 0
    const statH = props.th >= 120 ? 30 : 0
    const gSize = Math.max(44, Math.min(avail, Math.floor((props.th - pad * 2 - lh - statH - sparkRoom) / 0.7), 210))
    return (
      <div class="pd-metric pd-metric--gauge" style={{ padding: pad + 'px' }}>
        {labelEl}
        <div class="pd-gwrap" style={{ width: gSize + 'px', height: Math.round(gSize * 0.7) + 'px' }}>
          <Gauge value={pct} size={gSize} band={band} />
          <div class="pd-gwrap__c">
            <AnimatedNumber value={kind === 'cpu' ? num : Math.round(pct)} class="pd-gwrap__n" style={{ fontSize: Math.round(gSize * 0.22) + 'px' }} suffix="%" />
          </div>
        </div>
        {statH ? (
          <div class="pd-gstat">
            <span class="pd-gstat__m" style={{ color: BAND_COLOR[band] }}>
              <i style={{ background: BAND_COLOR[band] }} />
              {t(BAND_TEXT[band])}
            </span>
            {deltaEl(11)}
          </div>
        ) : null}
        {sparkRoom && data ? <SlotSpark values={windowSeries(data, winSec, 60)} color={color} height={sparkRoom} minRange={20} /> : null}
      </div>
    )
  }

  // ring / donut: circular, beside the numbers when the tile is wide
  if ((chart === 'ring' || chart === 'donut') && s) {
    const wide = props.tw >= props.th * 1.5 && props.tw >= 150
    const dia = wide ? Math.max(40, Math.min(props.th - pad * 2, 200, Math.floor((props.tw - pad * 2) * 0.5))) : Math.max(36, Math.min(avail, props.th - pad * 2 - lh, 200))
    const centre = Math.round(pct) + '%'
    const fig =
      chart === 'donut' ? (
        <Donut size={dia} used={pct} color={color} center={centre} />
      ) : (
        <Rings size={dia} rings={[{ value: pct, goal: 100, color: color }]} center={centre} />
      )
    if (!wide) {
      return (
        <div class="pd-metric pd-metric--gauge" style={{ padding: pad + 'px' }}>
          {labelEl}
          <div class="pd-cfig">{fig}</div>
        </div>
      )
    }
    // the number + unit must fit the room beside the ring (a 3x2 tile on a small phone left "GB" outside the tile)
    const textW = Math.max(30, props.tw - pad * 2 - dia - 12)
    const vs = Math.max(10, Math.min(34 * props.scale, Math.floor((props.th - pad * 2 - lh) * 0.4), fit(fmt(num).length + (unit ? 1 + Math.ceil(unit.length * 0.5) : 0), textW, 34, 10)))
    const free = s.memTotal ? (s.memTotal - s.memUsed) / GB : 0
    return (
      <div class="pd-metric pd-metric--circ" style={{ padding: pad + 'px' }}>
        <div class="pd-cfig pd-cfig--l">{fig}</div>
        <div class="pd-ctxt">
          {labelEl}
          {bigNum(vs)}
          <div class="pd-cdelta">{deltaEl(11)}</div>
          {showSubOpt && chart === 'donut' && props.th >= 100 ? (
            <div class="pd-msub pd-legend">
              <span>
                <i class="pd-ldot" style={{ background: color }} />
                {t('Used {0} GB', (s.memUsed / GB).toFixed(1))}
              </span>
              <span>
                <i class="pd-ldot" style={{ background: tint(color, 0.28) || color }} />
                {t('Free {0} GB', free.toFixed(1))}
              </span>
            </div>
          ) : showSubOpt && sub ? (
            <div class="pd-msub">{sub}</div>
          ) : null}
        </div>
      </div>
    )
  }

  // bar: one horizontal meter with a limit tick
  if (chart === 'bar' && s) {
    const bp = props.th < 100 ? 8 : pad
    const thick = props.th >= 110 ? 10 : 6
    const subOn = showSubOpt && !!sub && props.th >= 130
    const vs = Math.max(14, Math.min(34 * props.scale, props.th - bp * 2 - lh - thick - 16 - (subOn ? 16 : 0), Math.floor(avail / 4)))
    return (
      <div class="pd-metric" style={{ padding: bp + 'px' }}>
        {labelEl}
        <div class="pd-mrow">
          {bigNum(vs)}
          {props.tw >= 150 && props.th >= 90 ? deltaEl(11) : null}
        </div>
        <div class="pd-mfill" />
        {subOn ? <div class="pd-msub">{sub}</div> : null}
        <MeterBar value={pct} limit={85} color={color} thick={thick} />
      </div>
    )
  }

  const isNet = kind === 'network'
  const noChart = chart === 'number' || !data
  // tall tiles (2x3...): the chart takes the height the text does not need, and the number grows with it
  const tallM = props.th >= props.tw * 1.25 && props.th >= 200
  const sparkH = noChart ? 0 : tallM ? Math.round(props.th * 0.5) : !compact ? Math.max(16, Math.min(isNet ? 70 : 60, Math.round(props.th * (isNet ? 0.34 : 0.22)))) : Math.max(12, Math.round(props.th * 0.2))
  const textRoom = props.th - sparkH - pad
  const maxV = (roomy ? 38 : 26) * props.scale * (chart === 'number' ? 1.6 : 1) * (tallM ? 1.3 : 1)
  const vSize = Math.max(9, Math.min(fit(fmt(num).length + 1 + (unit ? 2 : 0), avail, maxV, 9), Math.floor(textRoom * (props.showLabel ? 0.5 : 0.7)) * (chart === 'number' ? 1.2 : 1)))
  const lSize = Math.max(8, Math.min(11, fit(label.length, avail, 11, 8)))
  const showSub = showSubOpt && (!!sub || isNet) && !compact && textRoom >= vSize + lSize + 30
  const showDelta = showDeltaOpt && !!delta && !compact && props.tw >= 150 && textRoom >= vSize + lSize + 6
  const tc = props.textColor || undefined
  const subSize = Math.max(9, Math.min(12, fit(isNet ? 18 : sub.length, avail, 12, 9)))
  const slots = Math.max(12, Math.min(60, Math.floor(props.tw / 5)))
  const ser = !noChart && data ? windowSeries(data, winSec, chart === 'bars' ? slots : 60) : []
  const txSer = isNet && !noChart ? windowSeries(props.hist.tx, winSec, chart === 'bars' ? slots : 60) : []
  const netMax = Math.max(1, Math.max.apply(null, ser.concat(txSer)) * 1.15)
  let chartEl = null
  if (!noChart && data) {
    if (chart === 'bars') {
      const dom: [number, number] = max ? [0, max] : [0, isNet ? netMax : Math.max(0.1, Math.max.apply(null, ser) * 1.15)]
      chartEl = <BarSpark values={ser} color={color} height={sparkH} slots={slots} domain={dom} inset={pad} />
    } else if (isNet) {
      chartEl = <SlotSpark values={ser} color={color} height={sparkH} fill={chart === 'area' ? 0.4 : undefined} domain={[0, netMax]} extra={{ values: txSer, color: tint(color, 0.5) || color }} />
    } else {
      chartEl = <SlotSpark values={ser} color={color} height={sparkH} fill={chart === 'area' ? 0.4 : undefined} minRange={max ? 20 : 0} />
    }
  }
  return (
    <div class={'pd-metric' + (tallM && noChart ? ' pd-metric--mid' : '')} style={{ padding: pad + 'px', paddingBottom: pad + 'px' }}>
      {props.showLabel ? (
        <div class="pd-ml" style={{ fontSize: lSize + 'px', color: props.textColor || color }}>
          {label}
        </div>
      ) : null}
      <div class="pd-mrow">
        <div class="pd-mv" style={{ fontSize: vSize + 'px', color: tc }}>
          <AnimatedNumber value={num} format={fmt} />
          {unit ? <span class="pd-mu" style={{ fontSize: Math.max(9, Math.round(vSize * 0.42)) + 'px' }}>{' ' + unit}</span> : null}
        </div>
        {showDelta && delta ? <DeltaPill value={delta.v} unit={delta.unit} decimals={delta.dec} tone={delta.tone} size={11} /> : null}
      </div>
      {showSub && !isNet ? (
        <div class="pd-msub" style={{ fontSize: subSize + 'px' }}>
          {sub}
        </div>
      ) : null}
      {showSub && isNet ? (
        <div class="pd-msub" style={{ fontSize: subSize + 'px' }}>
          <i class="pd-ldot" style={{ background: tint(color, 0.5) || color }} />
          {'↑ ' + fmtRateStr(s && s.net ? s.net.tx : 0)}
        </div>
      ) : null}
      {chartEl}
    </div>
  )
}
