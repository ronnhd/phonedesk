import { relTime, useTick } from './automation'
import { t } from './i18n'
import type { PushedValue, PushOptions } from './types'

type Row = { title: string; outcome: string; price: string; pnl: string; avg?: string; now?: string; shares?: string; traded?: string; towin?: string; value?: string; pct?: string; icon?: string }

/** Compact live view of pushed Polymarket positions. `sub` carries `sum~count~value~pnl|title~outcome~price~pnl|...`. */
export function PolyLiveTile(props: {
  cfg?: PushOptions
  val?: PushedValue
  tw: number
  th: number
  color?: string
  textColor?: string
  showLabel: boolean
}) {
  const now = useTick(15000)
  const parts = (props.val?.sub || '').split('|').filter(Boolean)
  const first = parts.length ? parts.shift()! : ''
  const summary = (first.startsWith('sum~') ? first.slice(4) : first).split('~')
  const items = props.val?.items || []
  const source = items.length ? items : parts
  const maxRows = items.length ? 50 : props.th >= 150 ? 3 : props.th >= 110 ? 2 : 1
  const rows: Row[] = source.slice(0, maxRows).map((part) => {
    const cells = String(part).split('~')
    if (cells.length >= 11) {
      return {
        title: cells[0] || '', outcome: cells[1] || '', avg: cells[2] || '', now: cells[3] || '',
        shares: cells[4] || '', traded: cells[5] || '', towin: cells[6] || '', value: cells[7] || '',
        pnl: cells[8] || '', pct: cells[9] || '', icon: cells[10] || '', price: cells[2] || '',
      }
    }
    return { title: cells[0] || '', outcome: cells[1] || '', price: cells[2] || '', pnl: cells[3] || '' }
  })
  const wide = props.tw >= 520 && props.th >= 140
  const full = props.tw >= 900 && props.th >= 400
  const count = summary[0] ?? String(props.val?.value ?? '–')
  const value = summary[1] ?? '–'
  const pnl = summary[2] ?? '–'
  const pnlNegative = Number(pnl) < 0
  return (
    <div class={'pd-poly' + (props.th < 110 ? ' pd-poly--compact' : '') + (wide ? ' pd-poly--wide' : '') + (full ? ' pd-poly--full' : '')} style={{ color: props.textColor || undefined }}>
      {props.showLabel ? <span class="pd-poly__lb" style={{ color: props.color || undefined }}>{props.cfg?.label || t('Polymarket')}</span> : null}
      <span class="pd-poly__sum">
        <b>{count}</b> {t('open')}
        <i>·</i> ${value}
        <i>·</i>
        <em class={pnlNegative ? 'pd-poly__pnl pd-poly__pnl--neg' : 'pd-poly__pnl'}>
          {pnlNegative ? '' : '+'}{pnl}
        </em>
      </span>
      <div class="pd-poly__rows">
        {rows.length ? rows.map((row, i) => {
          const negative = Number(row.pnl) < 0
          if (full) {
            return (
              <div class="pd-poly__card" key={i}>
                <div class="pd-poly__chead">
                  {row.icon ? <img class="pd-poly__cicon" src={row.icon} alt="" /> : <span class="pd-poly__cicon pd-poly__cicon--blank">◈</span>}
                  <span class="pd-poly__ctitle">{row.title}</span>
                </div>
                <div class="pd-poly__cside">{row.outcome} <b>{row.avg}</b></div>
                <div class="pd-poly__cshares">{row.shares} shares</div>
                <div class="pd-poly__cmetrics">
                  <div><span>Avg</span><b>{row.avg}</b></div>
                  <div><span>Now</span><b>{row.now}</b></div>
                  <div><span>Traded</span><b>${row.traded}</b></div>
                  <div><span>To win</span><b>${row.towin}</b></div>
                  <div><span>Value</span><b>${row.value}</b></div>
                </div>
                <div class={negative ? 'pd-poly__cpnl pd-poly__cpnl--neg' : 'pd-poly__cpnl'}>{row.pnl} {row.pct ? `(${row.pct})` : ''}</div>
              </div>
            )
          }
          return (
            <div class="pd-poly__row" key={i}>
              <span class="pd-poly__title">{row.title}</span>
              <span class="pd-poly__meta">{row.outcome === 'Y' ? 'Yes' : row.outcome === 'N' ? 'No' : row.outcome} {row.price}</span>
              <span class={negative ? 'pd-poly__pnl pd-poly__pnl--neg' : 'pd-poly__pnl'}>{row.pnl}</span>
            </div>
          )
        }) : <span class="pd-poly__empty">{props.val ? t('No open positions') : t('No data yet')}</span>}
      </div>
      {props.th >= 110 ? <span class="pd-poly__t">{props.val ? relTime(props.val.at, now) : t('No data yet')}</span> : null}
    </div>
  )
}
