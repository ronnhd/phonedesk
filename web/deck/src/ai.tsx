import { Rings } from './charts'
import { t } from './i18n'
import { BrandIcon, brandOf } from './brand-icons'
import { Icon } from './icon'
import { AnimatedNumber } from './knowns'
import { tint } from './theme'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Gauge } from './knowns'
import { SlotSpark } from './charts'
import type { AiData, AiProviderInfo, AiSession, AiWindow, QuotaOptions } from './types'

/** Session status pill: look of the status marks in Knowns UI Pro agent-health (blocks/analytics/agent-health.tsx), reduced to a pill that fits small rows. */
/** quota + sessions widgets (AI coding tools). Sizes come from the tile (tw/th in px). */

export interface AiWidgetProps {
  ai: AiData | null
  quota?: QuotaOptions
  provider?: string
  tw: number
  th: number
  scale: number
  showLabel: boolean
  color?: string
  textColor?: string
  /** projects with a permission request waiting; their sessions show as "Needs you" */
  waitingProjects: string[]
}

export const PROVIDER_COLOR: { [k: string]: string } = { claude: '#d97757', codex: '#e5e7eb', antigravity: '#60a5fa', opencode: '#38bdf8', grok: '#a1a1aa' }
export const PROVIDER_NAME: { [k: string]: string } = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', grok: 'Grok' }

const toMs = (v: number | string | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v // seconds or ms
  const n = Date.parse(v)
  return isNaN(n) ? null : n
}

/** "resets in 2h 10m" */
export function resetText(at: number | string | undefined): string {
  const ms = toMs(at)
  if (ms === null) return ''
  let min = Math.round((ms - Date.now()) / 60000)
  if (min <= 0) return t('just reset')
  const d = Math.floor(min / 1440)
  min -= d * 1440
  const h = Math.floor(min / 60)
  const m = min % 60
  if (d > 0) return t('resets in {0}', t('{0}d', d) + (h ? ' ' + t('{0}h', h) : ''))
  if (h > 0) return t('resets in {0}', t('{0}h', h) + (m ? ' ' + t('{0}m', m) : ''))
  return t('resets in {0}', t('{0}m', m))
}

/** "3 min ago" */
export function agoText(at: number | string | undefined, short?: boolean): string {
  const ms = toMs(at)
  if (ms === null) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return t('just now')
  const m = Math.floor(s / 60)
  let out: string
  if (m < 60) out = t('{0} min ago', m)
  else {
    const h = Math.floor(m / 60)
    out = h < 24 ? t('{0}h ago', h) : t('{0}d ago', Math.floor(h / 24))
  }
  return short ? out.replace(/ (trước|ago)$/, '') : out
}

/** Ring colour for window k: the provider colour at decreasing strength, warn/bad past 75/90%. */
const ringColor = (color: string, k: number, p: number) => (level(p) ? (p >= 90 ? '#f87171' : '#f59e0b') : tint(color, k === 0 ? 1 : k === 1 ? 0.62 : 0.4) || color)
const ringsOf = (wins: AiWindow[], color: string) => wins.slice(0, 3).map((w, k) => ({ value: w.usedPercent, goal: 100, color: ringColor(color, k, w.usedPercent) }))

const level = (p: number) => (p >= 90 ? 'var(--pd-bad)' : p >= 75 ? 'var(--pd-warn)' : '')

/**
 * Usage-meter look (Knowns UI Pro registry/knowns/ui/knowns/usage-meter/usage-meter.tsx + usage-utils.ts: usageState, statusText,
 * the 10px bar with the warn hairline, the 4px "limits" meters, the state glyph and the reset line). Vietnamese copy, no segments.
 */
type UState = 'ok' | 'warn' | 'limit'
const stateOf = (p: number): UState => (p >= 100 ? 'limit' : p >= 80 ? 'warn' : 'ok')
const STATE_COLOR: { [k: string]: string } = { warn: '#f59e0b', limit: '#f87171' }
const statusLine = (p: number) => {
  const st = stateOf(p)
  if (st === 'limit') return t('Limit reached')
  const used = Math.floor(p)
  return (st === 'warn' ? t('Almost out') + ' · ' : t('{0}% used', used) + ' · ') + t('{0}% left', Math.max(0, 100 - used))
}
/** State glyph: Tabler "alert-triangle" (warn) and "ban" (limit). */
function Glyph(props: { st: UState }) {
  if (props.st === 'ok') return null
  return <Icon name={props.st === 'warn' ? 'alert-triangle' : 'ban'} size={13} class="pd-um__gi" />
}
function MeterMain(props: { w: AiWindow; color: string; showReset?: boolean }) {
  const p = Math.max(0, props.w.usedPercent)
  const st = stateOf(p)
  const rs = props.showReset === false ? '' : resetText(props.w.resetsAt)
  return (
    <div class="pd-um">
      <div class="pd-um__tot">
        <AnimatedNumber value={Math.round(p)} suffix="%" class="pd-um__n" />
        <span class="pd-um__w">{props.w.label}</span>
      </div>
      <div class="pd-um__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(p))}>
        <span class="pd-um__f" style={{ width: Math.min(100, p) + '%', background: STATE_COLOR[st] || props.color }} />
        <span class="pd-um__hair" style={{ left: '80%' }} />
      </div>
      <div class="pd-um__s" style={{ color: STATE_COLOR[st] || undefined }}>
        <Glyph st={st} />
        {statusLine(p)}
      </div>
      {rs ? <div class="pd-um__r">{rs}</div> : null}
    </div>
  )
}
function MeterLimit(props: { w: AiWindow; color: string; showReset?: boolean }) {
  const p = Math.max(0, props.w.usedPercent)
  const st = stateOf(p)
  const rs = props.showReset === false ? '' : resetText(props.w.resetsAt)
  return (
    <div class="pd-ul">
      <div class="pd-ul__top">
        <span>{props.w.label}</span>
        <span style={{ color: STATE_COLOR[st] || undefined }}>
          {st === 'limit' ? t('Full') + ' · ' : st === 'warn' ? t('Nearly full') + ' · ' : ''}
          {Math.round(p) + '%'}
        </span>
      </div>
      <div class="pd-ul__bar">
        <span style={{ width: Math.min(100, p) + '%', background: STATE_COLOR[st] || props.color }} />
      </div>
      {rs ? <div class="pd-um__r">{rs}</div> : null}
    </div>
  )
}

/* ---------- quota charts (item.quota.chart) ---------- */

interface ChartIn {
  wins: AiWindow[]
  color: string
  showReset: boolean
  w: number
  h: number
}
const stateColor = (p: number, color: string) => STATE_COLOR[stateOf(p)] || color
const winColor = (color: string, k: number, p: number) => STATE_COLOR[stateOf(p)] || tint(color, k === 0 ? 1 : k === 1 ? 0.62 : 0.4) || color

/** bars: one horizontal bar per window (usage-meter limit bars). */
function BarsChart(c: ChartIn) {
  const rowH = c.showReset ? 34 : 30
  const n = Math.max(1, Math.min(c.wins.length, Math.floor(c.h / rowH)))
  const rows = c.wins.slice(0, n)
  return (
    <div class="pd-qb">
      {rows.map((w) => {
        const p = Math.max(0, w.usedPercent)
        const rs = c.showReset ? resetText(w.resetsAt) : ''
        return (
          <div class="pd-qb__r" key={w.id}>
            <div class="pd-ul__top">
              <span>{w.label}</span>
              <span style={{ color: STATE_COLOR[stateOf(p)] || undefined }}>{Math.round(p) + '%'}</span>
            </div>
            <div class="pd-ul__bar pd-qb__bar">
              <span style={{ width: Math.min(100, p) + '%', background: stateColor(p, c.color) }} />
            </div>
            {rs && rowH * n <= c.h ? <div class="pd-um__r">{rs}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

/** rings: concentric rings (goal-rings look), with a legend beside it on wide tiles. */
function RingsChart(c: ChartIn) {
  const wide = c.w >= c.h * 1.4 && c.w >= 200
  const wins = c.wins.slice(0, 3)
  const main = wins[0]
  const size = Math.max(40, Math.min(wide ? c.h : Math.min(c.w, c.h), 170))
  const rings = wins.map((w, k) => ({ value: w.usedPercent, goal: 100, color: winColor(c.color, k, w.usedPercent) }))
  const fig = <Rings size={size} rings={rings} center={main ? Math.round(main.usedPercent) + '%' : '-'} />
  const legend = (
    <div class="pd-qlg">
      {wins.map((w, k) => (
        <div class="pd-qlg__r" key={w.id}>
          <i style={{ background: winColor(c.color, k, w.usedPercent) }} />
          <span class="pd-qlg__l">{w.label}</span>
          <b>{Math.round(w.usedPercent) + '%'}</b>
          {c.showReset && resetText(w.resetsAt) ? <em>{resetText(w.resetsAt)}</em> : null}
        </div>
      ))}
    </div>
  )
  if (wide) {
    return (
      <div class="pd-qrow">
        <div class="pd-qfig">{fig}</div>
        {legend}
      </div>
    )
  }
  return (
    <div class="pd-qcol">
      {fig}
      {c.h >= size + 20 * wins.length + 8 && wins.length > 1 ? legend : null}
    </div>
  )
}

/** gauge: agent-health arc of the main window. */
function GaugeChart(c: ChartIn) {
  const w0 = c.wins[0]
  if (!w0) return null
  const p = Math.max(0, w0.usedPercent)
  const rs = c.showReset ? resetText(w0.resetsAt) : ''
  const lineH = 18 + (rs ? 14 : 0)
  const g = Math.max(52, Math.min(c.w, Math.floor((c.h - lineH) / 0.7), 200))
  const st = stateOf(p)
  return (
    <div class="pd-qcol">
      <div class="pd-gwrap" style={{ width: g + 'px', height: Math.round(g * 0.7) + 'px' }}>
        <Gauge value={p} size={g} band={st === 'limit' ? 'risk' : st === 'warn' ? 'watch' : 'good'} color={stateColor(p, c.color)} />
        <div class="pd-gwrap__c">
          <AnimatedNumber value={Math.round(p)} class="pd-gwrap__n" style={{ fontSize: Math.round(g * 0.22) + 'px' }} suffix="%" />
        </div>
      </div>
      {c.h >= g * 0.7 + 18 ? <div class="pd-qcap">{w0.label}</div> : null}
      {rs && c.h >= g * 0.7 + 34 ? <div class="pd-um__r">{rs}</div> : null}
    </div>
  )
}

/** number: the percentage only (other windows as one small line each when there is room). */
function NumberChart(c: ChartIn) {
  const w0 = c.wins[0]
  if (!w0) return null
  const p = Math.max(0, w0.usedPercent)
  const rs = c.showReset ? resetText(w0.resetsAt) : ''
  const size = Math.max(18, Math.min(Math.floor(c.h * 0.5), Math.floor(c.w / 2.6), 64))
  const others = c.wins.slice(1, 1 + Math.max(0, Math.floor((c.h - size - 24) / 16)))
  return (
    <div class="pd-qnum">
      <div class="pd-qnum__v" style={{ fontSize: size + 'px', color: STATE_COLOR[stateOf(p)] || undefined }}>
        <AnimatedNumber value={Math.round(p)} suffix="%" />
      </div>
      <div class="pd-qcap">{w0.label}</div>
      {rs && c.h >= size + 34 ? <div class="pd-um__r">{rs}</div> : null}
      {others.map((w) => (
        <div class="pd-qnum__o" key={w.id}>
          <span>{w.label}</span>
          <b style={{ color: STATE_COLOR[stateOf(w.usedPercent)] || undefined }}>{Math.round(w.usedPercent) + '%'}</b>
        </div>
      ))}
    </div>
  )
}

/** history: usage over the last hours, a Knowns Sparkline per window with an end dot and a marker where the window reset. */
function HistoryChart(c: ChartIn) {
  const rowMin = 54
  const n = Math.max(1, Math.min(c.wins.length, Math.floor(c.h / rowMin)))
  const rowH = Math.floor(c.h / n)
  const rows = c.wins.slice(0, n)
  return (
    <div class="pd-qh">
      {rows.map((w, k) => {
        const pts = (w.history || []).filter((x) => x && x.length >= 2)
        const vals = pts.map((x) => x[1])
        // a reset shows as a sharp drop in used percent
        const resets: number[] = []
        for (let i = 1; i < vals.length; i++) if (vals[i - 1] - vals[i] >= 30) resets.push(i)
        const p = Math.max(0, w.usedPercent)
        const sh = Math.max(20, rowH - 22)
        return (
          <div class="pd-qh__r" key={w.id} style={{ height: rowH + 'px' }}>
            <div class="pd-ul__top">
              <span>{w.label}</span>
              <span style={{ color: STATE_COLOR[stateOf(p)] || undefined }}>{Math.round(p) + '%'}</span>
            </div>
            {vals.length >= 2 ? (
              <div class="pd-qh__c" style={{ height: sh + 'px' }}>
                <SlotSpark values={vals} slots={vals.length} color={winColor(c.color, k, p)} height={sh} domain={[0, 100]} />
                {resets.map((i) => (
                  <i class="pd-qh__m" key={i} style={{ left: (i / (vals.length - 1)) * 100 + '%' }} />
                ))}
              </div>
            ) : (
              <div class="pd-qh__none" style={{ height: sh + 'px' }}>{t('No history yet')}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Tall tiles (2x3, 1x2, 2x4, 3x4 portrait): the chart owns the full height, every window the provider has is shown,
 * and the footer (credits) is outside this box so nothing overlaps it.
 */
function TallChart(c: ChartIn & { chart: string; narrow: boolean }) {
  const wins = c.wins
  const n = wins.length
  const main = wins[0]
  const others = wins.slice(1)
  const pct = (w: AiWindow) => Math.max(0, w.usedPercent)
  const thinBar = (w: AiWindow, h?: number) => (
    <div class="pd-qt__bar" style={h ? { height: h + 'px' } : undefined}>
      <span style={{ width: Math.min(100, pct(w)) + '%', background: stateColor(pct(w), c.color) }} />
    </div>
  )
  // squarish tiles (2x2, about 110px of body): resets and status lines only when every window still fits
  const compact = c.h < 200
  const rs = (w: AiWindow) => (c.showReset && (!compact || c.h >= n * 56) ? resetText(w.resetsAt) : '')

  // 1x2: a column of numbers, no room for text beyond the window label
  if (c.narrow) {
    const hero = c.chart === 'auto' || c.chart === 'rings' || c.chart === 'gauge'
    const per = 38
    const size = Math.max(40, Math.min(c.w, c.h - others.length * per - 6))
    return (
      <div class="pd-qt pd-qt--narrow">
        {hero && main ? (
          <div class="pd-qt__hero">
            <Rings size={size} rings={[{ value: main.usedPercent, goal: 100, color: stateColor(pct(main), c.color) }]} center={Math.round(pct(main)) + '%'} />
            <span class="pd-qt__cap">{main.label}</span>
          </div>
        ) : null}
        {(hero ? others : wins).map((w) => (
          <div class="pd-qt__nr" key={w.id}>
            <span class="pd-qt__cap">{w.label}</span>
            <b style={{ color: STATE_COLOR[stateOf(pct(w))] || undefined }}>{Math.round(pct(w)) + '%'}</b>
            {thinBar(w)}
          </div>
        ))}
      </div>
    )
  }

  if (compact && (c.chart === 'auto' || c.chart === 'rings' || c.chart === 'gauge')) {
    // 2x2: the ring / gauge on the left, every window listed on the right (label, %, bar)
    const fig = Math.max(52, Math.min(Math.floor(c.w * 0.36), c.h))
    const st = main ? stateOf(pct(main)) : 'ok'
    return (
      <div class="pd-qt pd-qt--side">
        <div class="pd-qt__fig">
          {c.chart === 'gauge' && main ? (
            <div class="pd-gwrap" style={{ width: fig + 'px', height: Math.round(fig * 0.7) + 'px' }}>
              <Gauge value={pct(main)} size={fig} band={st === 'limit' ? 'risk' : st === 'warn' ? 'watch' : 'good'} color={stateColor(pct(main), c.color)} />
              <div class="pd-gwrap__c">
                <AnimatedNumber value={Math.round(pct(main))} class="pd-gwrap__n" style={{ fontSize: Math.round(fig * 0.22) + 'px' }} suffix="%" />
              </div>
            </div>
          ) : (
            <Rings
              size={fig}
              rings={(c.chart === 'rings' ? wins.slice(0, 3) : main ? [main] : []).map((w, k) => ({ value: w.usedPercent, goal: 100, color: winColor(c.color, k, w.usedPercent) }))}
              center={main ? Math.round(pct(main)) + '%' : '-'}
            />
          )}
        </div>
        <div class="pd-qt__list">
          {wins.slice(0, 4).map((w) => (
            <div class="pd-qt__med" key={w.id}>
              <div class="pd-qt__rt">
                <span class="pd-qt__lb">{w.label}</span>
                <b style={{ color: STATE_COLOR[stateOf(pct(w))] || undefined }}>{Math.round(pct(w)) + '%'}</b>
              </div>
              {thinBar(w, 5)}
              {rs(w) ? <div class="pd-um__r">{rs(w)}</div> : null}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (c.chart === 'bars') {
    // every window a row: bigger label and %, thick bar, reset text; rows share the height evenly
    return (
      <div class="pd-qt pd-qt--even">
        {wins.map((w) => (
          <div class="pd-qt__row" key={w.id}>
            <div class="pd-qt__rt">
              <span class="pd-qt__lb">{w.label}</span>
              <b style={{ color: STATE_COLOR[stateOf(pct(w))] || undefined }}>{Math.round(pct(w)) + '%'}</b>
            </div>
            {thinBar(w, Math.max(10, Math.min(24, Math.round(c.h / n * 0.13))))}
            {rs(w) ? <div class="pd-um__r">{rs(w)}</div> : null}
          </div>
        ))}
      </div>
    )
  }

  if (c.chart === 'meter') {
    // one usage-meter block per window, stacked evenly
    return (
      <div class="pd-qt pd-qt--even">
        {wins.map((w) => {
          const p = pct(w)
          const st = stateOf(p)
          return (
            <div class="pd-qt__blk" key={w.id}>
              <div class="pd-um__tot">
                <AnimatedNumber value={Math.round(p)} suffix="%" class="pd-um__n" />
                <span class="pd-um__w">{w.label}</span>
              </div>
              <div class="pd-um__bar">
                <span class="pd-um__f" style={{ width: Math.min(100, p) + '%', background: STATE_COLOR[st] || c.color }} />
                <span class="pd-um__hair" style={{ left: '80%' }} />
              </div>
              {!compact || c.h >= n * 64 ? (
                <div class="pd-um__s pd-qm__s" style={{ color: STATE_COLOR[st] || undefined }}>
                  <Glyph st={st} />
                  {statusLine(p)}
                </div>
              ) : null}
              {rs(w) ? <div class="pd-um__r">{rs(w)}</div> : null}
            </div>
          )
        })}
      </div>
    )
  }

  if (c.chart === 'number') {
    // big main %, the others as medium numbers with a mini bar
    const big = Math.max(36, Math.min(Math.floor(c.w * 0.4), Math.floor((c.h - others.length * 56) * 0.55)))
    return (
      <div class="pd-qt pd-qt--between">
        {main ? (
          <div class="pd-qt__big">
            <div class="pd-qnum__v" style={{ fontSize: big + 'px', color: STATE_COLOR[stateOf(pct(main))] || undefined }}>
              <AnimatedNumber value={Math.round(pct(main))} suffix="%" />
            </div>
            <div class="pd-qcap">{main.label}</div>
            {rs(main) ? <div class="pd-um__r">{rs(main)}</div> : null}
          </div>
        ) : null}
        {others.map((w) => (
          <div class="pd-qt__med" key={w.id}>
            <div class="pd-qt__rt">
              <span class="pd-qt__lb">{w.label}</span>
              <b class="pd-qt__mn" style={{ color: STATE_COLOR[stateOf(pct(w))] || undefined }}>{Math.round(pct(w)) + '%'}</b>
            </div>
            {thinBar(w, 5)}
          </div>
        ))}
      </div>
    )
  }

  if (c.chart === 'rings') {
    // concentric rings + a legend with fixed spacing under them
    const legH = Math.min(3, n) * 36
    const size = Math.max(64, Math.min(c.w, c.h - legH - 10))
    return (
      <div class="pd-qt pd-qt--between">
        <div class="pd-qt__hero">
          <Rings size={size} rings={wins.slice(0, 3).map((w, k) => ({ value: w.usedPercent, goal: 100, color: winColor(c.color, k, w.usedPercent) }))} center={main ? Math.round(pct(main)) + '%' : '-'} />
        </div>
        <div class="pd-qt__leg">
          {wins.slice(0, 3).map((w, k) => (
            <div class="pd-qt__lr" key={w.id}>
              <i style={{ background: winColor(c.color, k, w.usedPercent) }} />
              <span class="pd-qt__lb">
                {w.label}
                {rs(w) ? <em>{rs(w)}</em> : null}
              </span>
              <b>{Math.round(pct(w)) + '%'}</b>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (c.chart === 'gauge') {
    // main gauge, the other windows as small bars under it
    const g = Math.max(72, Math.min(c.w, Math.floor((c.h - others.length * 52 - 64) / 0.7)))
    const st = main ? stateOf(pct(main)) : 'ok'
    return (
      <div class="pd-qt pd-qt--between">
        {main ? (
          <div class="pd-qt__hero">
            <div class="pd-gwrap" style={{ width: g + 'px', height: Math.round(g * 0.7) + 'px' }}>
              <Gauge value={pct(main)} size={g} band={st === 'limit' ? 'risk' : st === 'warn' ? 'watch' : 'good'} color={stateColor(pct(main), c.color)} />
              <div class="pd-gwrap__c">
                <AnimatedNumber value={Math.round(pct(main))} class="pd-gwrap__n" style={{ fontSize: Math.round(g * 0.22) + 'px' }} suffix="%" />
              </div>
            </div>
            <div class="pd-qcap">{main.label}</div>
            {rs(main) ? <div class="pd-um__r">{rs(main)}</div> : null}
          </div>
        ) : null}
        {others.map((w) => (
          <div class="pd-qt__med" key={w.id}>
            <div class="pd-qt__rt">
              <span class="pd-qt__lb">{w.label}</span>
              <b>{Math.round(pct(w)) + '%'}</b>
            </div>
            {thinBar(w, 6)}
          </div>
        ))}
      </div>
    )
  }

  // auto: ring hero for the main window + compact rows for the others
  const rowH = c.showReset ? 50 : 36
  const size = Math.max(64, Math.min(c.w, c.h - others.length * rowH - (c.showReset ? 46 : 34)))
  return (
    <div class="pd-qt pd-qt--between">
      {main ? (
        <div class="pd-qt__hero">
          <Rings size={size} rings={[{ value: main.usedPercent, goal: 100, color: stateColor(pct(main), c.color) }]} center={Math.round(pct(main)) + '%'} />
          <div class="pd-qcap">{main.label}</div>
          {rs(main) ? <div class="pd-um__r">{rs(main)}</div> : null}
        </div>
      ) : null}
      {others.map((w) => (
        <div class="pd-qt__med" key={w.id}>
          <div class="pd-qt__rt">
            <span class="pd-qt__lb">{w.label}</span>
            <b style={{ color: STATE_COLOR[stateOf(pct(w))] || undefined }}>{Math.round(pct(w)) + '%'}</b>
          </div>
          {thinBar(w, 5)}
          {rs(w) ? <div class="pd-um__r">{rs(w)}</div> : null}
        </div>
      ))}
    </div>
  )
}

/** Measures the box an element really got (Safari 12 has no ResizeObserver: re-measure after every render and on window resize). */
function useBox(): [{ current: HTMLDivElement | null }, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const measure = () => {
    const el = ref.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w && h && (Math.abs(w - box.w) > 1 || Math.abs(h - box.h) > 1)) setBox({ w: w, h: h })
  }
  useEffect(measure)
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })
  return [ref, box]
}

export function QuotaWidget(props: AiWidgetProps) {
  const id = props.provider || 'claude'
  const color = props.color || PROVIDER_COLOR[id] || '#8b8b94'
  const qo = props.quota || {}
  const info: AiProviderInfo | undefined = props.ai ? props.ai.providers.filter((p) => p.id === id)[0] : undefined
  const [accIdx, setAccIdx] = useState(0)
  const [bodyRef, mBox] = useBox()
  const name = (info && info.name) || PROVIDER_NAME[id] || id
  const accounts = (info && info.accounts) || []
  const pinned = qo.account ? accounts.filter((a) => a.id === qo.account || a.email === qo.account || a.displayName === qo.account || a.label === qo.account)[0] || null : null
  const cycling = !pinned && accounts.length > 1
  const acc = pinned || (cycling ? accounts[accIdx % accounts.length] : null)
  const cur = acc || accounts[0] || null
  const label = (cur && (cur.displayName || cur.email || cur.label)) || (info && (info.email || info.label)) || ''
  const needsLogin = (cur && cur.status === 'needs_login') || (info && info.status === 'needs_login')
  const srcTag = ''
  const wins0: AiWindow[] = (acc && acc.windows) || (info && info.windows) || []
  const plan = (acc && acc.plan) || (info && info.plan)
  const extras = (info && info.extras) || []
  const tw = props.tw
  const th = props.th
  const pad = th < 80 ? 7 : tw >= 170 ? 16 : 10
  const tc = props.textColor || undefined
  const showReset = qo.showReset !== false
  // only a 1x1-ish tile drops the header; everything wider shares one structure: header row, chart across the full width, status line
  const small = tw < 120 || th < 56
  const rawChart = qo.chart || 'auto'
  let chart = rawChart
  if (chart === 'auto') chart = small ? 'rings' : 'meter'
  const pick = Array.isArray(qo.windows) ? qo.windows : null
  // a list keeps only those ids, in that order (unknown ids are skipped); the first one is the hero
  const wins: AiWindow[] = pick
    ? pick.map((id) => wins0.filter((w) => w.id === id)[0]).filter((w): w is AiWindow => !!w).slice(0, 6)
    : qo.windows === 'main'
      ? wins0.slice(0, 1)
      : wins0
  const noPicked = !!pick && !wins.length && wins0.length > 0

  const mono = !!props.textColor
  const mark = (sz: number) => (
    <span class="pd-qmark" style={{ width: sz + 'px', height: sz + 'px', color: tc || color }}>
      {brandOf(id) ? <BrandIcon brand={brandOf(id)} size={Math.round(sz * 0.72)} mono={mono} /> : <b style={{ fontSize: Math.round(sz * 0.55) + 'px' }}>{name.charAt(0)}</b>}
    </span>
  )
  const nameTag = props.showLabel ? (
    <div class="pd-qname" style={{ color: color }}>
      {brandOf(id) ? <BrandIcon brand={brandOf(id)} size={13} mono={mono} class="pd-qname__i" /> : null}
      {name}
    </div>
  ) : null

  // tall tiles use the full height; 1x2 (narrow) is a column of numbers under the logo
  const tallish = ((th >= tw * 1.25 && th >= 170) || (th >= tw * 0.85 && th >= 170 && tw >= 150)) && rawChart !== 'history' && wins.length > 0 && !needsLogin
  if (tallish && tw < 120) {
    const ci: ChartIn & { chart: string; narrow: boolean } = { wins: wins, color: color, showReset: false, w: mBox.w || tw - pad * 2, h: mBox.h || th - pad * 2 - 30 - (extras.length ? 14 : 0), chart: rawChart, narrow: true }
    return (
      <div class="pd-quota pd-quota--tn" style={{ padding: pad + 'px', color: tc }}>
        <div class="pd-qt__mk">{mark(24)}</div>
        <div class="pd-qbody pd-qbody--fill" ref={bodyRef}>
          <TallChart {...ci} />
        </div>
      </div>
    )
  }

  // compact row (2x1 on a small phone): mark, full name, a short bar and the percentage, all on one line
  if (!small && th < 84 && tw >= 120 && wins.length && !needsLogin && chart !== 'rings' && chart !== 'gauge') {
    const p0 = Math.max(0, wins[0].usedPercent)
    const sc = STATE_COLOR[stateOf(p0)] || color
    return (
      <div class="pd-quota pd-quota--row" style={{ padding: '0 ' + (tw >= 170 ? 14 : 10) + 'px', color: tc }}>
        {mark(24)}
        <div class="pd-qrow__n">
          <b style={{ color: tc }}>{name}</b>
          {tw >= 240 && plan ? <em class="pd-qplan">{plan}</em> : null}
        </div>
        <span class="pd-qrow__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(p0))}>
          <i style={{ width: Math.min(100, p0) + '%', background: sc }} />
        </span>
        <span class="pd-qrow__p" style={{ color: sc }}>{Math.round(p0)}%</span>
      </div>
    )
  }

  // small tiles: the chart alone with the provider name under it
  if (small) {
    const room = th - pad * 2 - (props.showLabel ? 16 : 0)
    const ci: ChartIn = { wins: wins, color: color, showReset: false, w: tw - pad * 2, h: room }
    let body: any = null
    if (!wins.length) body = <div class={'pd-qempty' + (noPicked ? ' pd-qempty--msg' : '')}>{noPicked ? t('No data for this window yet') : info && info.error ? '!' : '-'}</div>
    else if (chart === 'bars') body = BarsChart(ci)
    else if (chart === 'gauge') body = GaugeChart(ci)
    else if (chart === 'number') body = NumberChart(ci)
    else if (chart === 'history') body = HistoryChart(ci)
    else if (chart === 'meter') body = <MeterMain w={wins[0]} color={color} showReset={false} />
    else {
      const size = Math.max(36, Math.min(tw - pad * 2, room, 90))
      body = <Rings size={size} rings={ringsOf(wins, color)} center={Math.round(Math.max.apply(null, wins.map((w) => w.usedPercent))) + '%'} />
    }
    return (
      <div class={'pd-quota pd-quota--small' + (tw >= 200 && (chart === 'bars' || chart === 'history' || chart === 'meter') ? ' pd-quota--wide' : '')} style={{ padding: pad + 'px', color: tc }}>
        {body}
        {nameTag}
      </div>
    )
  }

  const roomy = th >= 130
  const headH = 34
  const bodyH = th - pad * 2 - headH - (extras.length && roomy ? 18 : 0)
  const bodyW = tw - pad * 2
  const ci: ChartIn = { wins: wins, color: color, showReset: showReset, w: bodyW, h: bodyH }
  let body: any = null
  const tallCi: ChartIn & { chart: string; narrow: boolean } = { wins: wins, color: color, showReset: showReset, w: mBox.w || bodyW, h: mBox.h || bodyH, chart: rawChart, narrow: false }
  if (needsLogin || !wins.length) body = null
  else if (tallish) body = <TallChart {...tallCi} />
  else if (chart === 'bars') body = BarsChart(ci)
  else if (chart === 'rings') body = RingsChart(ci)
  else if (chart === 'gauge') body = GaugeChart(ci)
  else if (chart === 'number') body = NumberChart(ci)
  else if (chart === 'history') body = HistoryChart(ci)
  else {
    // meter: bar across the full inner width, one status line; extra windows stack under it when there is room
    const w0 = wins[0]
    const p0 = Math.max(0, w0.usedPercent)
    const st0 = stateOf(p0)
    const rs0 = showReset && tw >= 230 ? resetText(w0.resetsAt) : ''
    const limitsRoom = roomy ? Math.floor((bodyH - 34 - 10 - 8 - 18) / 38) : 0
    body = (
      <div class="pd-qm">
        {roomy ? (
          <div class="pd-um__tot">
            <AnimatedNumber value={Math.round(p0)} suffix="%" class="pd-um__n" />
            <span class="pd-um__w">{w0.label}</span>
          </div>
        ) : null}
        <div class="pd-um__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(p0))}>
          <span class="pd-um__f" style={{ width: Math.min(100, p0) + '%', background: STATE_COLOR[st0] || color }} />
          <span class="pd-um__hair" style={{ left: '80%' }} />
        </div>
        <div class="pd-um__s pd-qm__s" style={{ color: STATE_COLOR[st0] || undefined }}>
          <Glyph st={st0} />
          {statusLine(p0) + (rs0 ? ' · ' + rs0 : '')}
        </div>
        {wins.slice(1, 1 + Math.max(0, Math.min(3, limitsRoom))).map((w) => (
          <MeterLimit key={w.id} w={w} color={color} showReset={showReset && roomy} />
        ))}
      </div>
    )
  }
  return (
    <div class={'pd-quota' + (th < 100 ? ' pd-quota--short' : '')} style={{ padding: pad + 'px', color: tc }}>
      <div class={'pd-qhead' + (cycling ? ' pd-qhead--cycle' : '')} onClick={cycling ? () => setAccIdx(accIdx + 1) : undefined}>
        {mark(tw < 150 ? 20 : 26)}
        <div class="pd-qtitle">
          <b style={{ color: tc }}>
            {name}
            {plan && tw >= 190 ? <em class="pd-qplan">{plan}</em> : null}
          </b>
          {label || srcTag ? (
            <span class="pd-qacc">
              {[label ? label + (cycling ? ' (' + ((accIdx % accounts.length) + 1) + '/' + accounts.length + ')' : '') + (acc && acc.stale ? ' · ' + t('stale') : '') : '', srcTag].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </div>
        {chart === 'meter' && !roomy && wins.length && !needsLogin ? (
          <span class="pd-qhead__p" style={{ color: STATE_COLOR[stateOf(Math.max(0, wins[0].usedPercent))] || tc }}>
            <AnimatedNumber value={Math.round(Math.max(0, wins[0].usedPercent))} suffix="%" />
            {tw >= 260 ? <i>{wins[0].label}</i> : null}
          </span>
        ) : null}
      </div>
      {id === 'grok' && !wins.length && !needsLogin ? <div class="pd-qerr pd-qerr--mute">{t('No usage data from Grok')}</div> : !info ? <div class="pd-qerr">{t('No data yet')}</div> : null}
      {needsLogin ? <div class="pd-qerr pd-qerr--warn">{t('Sign in again on your computer')}</div> : null}
      {info && info.error && !needsLogin && id !== 'grok' ? <div class="pd-qerr">{info.error}</div> : null}
      {noPicked && !needsLogin ? <div class="pd-qerr pd-qerr--mute">{t('No data for this window yet')}</div> : null}
      {body ? <div ref={tallish ? bodyRef : undefined} class={'pd-qbody' + (chart === 'meter' || chart === 'bars' || chart === 'history' || tallish ? ' pd-qbody--fill' : '')}>{body}</div> : null}
      {extras.length && roomy ? (
        <div class="pd-qextra">
          {extras.map((x) => x.label + ': ' + x.value + (x.unit ? ' ' + x.unit : '')).join(' · ')}
        </div>
      ) : null}
    </div>
  )
}

const STATE_TEXT: { [k: string]: string } = { working: 'Working', waiting: 'Needs you', idle: 'Idle' }

/**
 * Sessions: the row look of Knowns UI agent-fleet / agent-monitor (agent-monitor/agent-monitor.tsx: a state mark, the agent name,
 * its model and tool, a state tag and a ticking clock since the last activity). Only the docs summary of those components was
 * read, so the row is built from their described anatomy, not ported line by line.
 */
const elapsed = (sec: number) => {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? h + 'h' + (m < 10 ? '0' : '') + m : (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

export function SessionsWidget(props: AiWidgetProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const all: AiSession[] = props.ai ? props.ai.sessions.slice() : []
  const waitingSet: { [k: string]: boolean } = {}
  props.waitingProjects.forEach((p) => (waitingSet[p] = true))
  const list = all
    .map((s) => (waitingSet[s.project] ? Object.assign({}, s, { state: 'waiting' as const }) : s))
    .sort((a, b) => (toMs(b.updatedAt) || 0) - (toMs(a.updatedAt) || 0))
  const pad = props.tw >= 170 ? 14 : 8
  const compact = props.tw < 150
  const rowH = compact ? 34 : 50
  const head = props.showLabel ? 24 : 0
  const n = Math.max(1, Math.floor((props.th - pad * 2 - head) / (rowH + 6)))
  const tc = props.textColor || undefined
  const now = Date.now()
  return (
    <div class="pd-sessions" style={{ padding: pad + 'px', color: tc }}>
      {props.showLabel ? <div class="pd-ml" style={{ fontSize: '10px', color: props.color || 'var(--pd-muted)' }}>{t('AI sessions').toUpperCase()}</div> : null}
      {list.length === 0 ? <div class="pd-sessions__none">{t('No sessions')}</div> : null}
      {list.slice(0, n).map((s) => {
        const since = Math.max(0, Math.floor((now - (toMs(s.updatedAt) || now)) / 1000))
        const live = s.state !== 'idle' && since < 86400
        return (
          <div class={'pd-ses pd-ses--' + s.state} key={s.id} style={{ height: rowH + 'px' }}>
            <i class={'pd-sdot pd-sdot--' + s.state} />
            <div class="pd-ses__m">
              <div class="pd-ses__t">
                <BrandIcon brand={brandOf(s.tool, true)} size={compact ? 13 : 16} mono={!!props.textColor} class="pd-ses__i" />
                <b>{s.project}</b>
              </div>
              {!compact ? <div class="pd-ses__s">{[PROVIDER_NAME[s.tool] || s.tool, s.model].filter(Boolean).join(' · ')}</div> : null}
              {compact ? <div class="pd-ses__s">{live ? <AnimatedNumber value={since} format={elapsed} /> : agoText(s.updatedAt, true)}</div> : null}
            </div>
            <div class="pd-ses__r">
              {(!compact && props.tw >= 230) ? <span class={'pd-stat pd-stat--' + s.state}>{t(STATE_TEXT[s.state])}</span> : null}
              {!compact ? <span class="pd-ses__clock">{live ? <AnimatedNumber value={since} format={elapsed} /> : agoText(s.updatedAt, true)}</span> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
