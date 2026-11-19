import { relTime, useTick } from './automation'
import { t } from './i18n'
import type { PushedValue, PushOptions } from './types'

type Row = { title: string; outcome: string; price: string; pnl: string }

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
