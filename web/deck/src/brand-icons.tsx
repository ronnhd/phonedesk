/**
 * Brand marks come from BRANDS in web/shared/icons.ts (official marks from LobeHub static SVGs, MIT, via iconSvg()).
 * No separate icon package in the deck.
 */
import { Icon } from './icon'

export type Brand = 'claude' | 'codex' | 'antigravity' | 'claude-code' | 'opencode' | 'grok'

/** Provider id or session tool -> brand. `session` picks the Claude Code mark for tool "claude". */
export const brandOf = (id: string, session?: boolean): Brand | null => {
  if (id === 'claude') return session ? 'claude-code' : 'claude'
  if (id === 'codex') return 'codex'
  if (id === 'antigravity') return 'antigravity'
  if (id === 'opencode' || id === 'omni') return 'opencode'
  if (id === 'grok') return 'grok'
  return null
}

/** Inline brand mark, crisp at 14-28px (colour where the brand has one). */
export function BrandIcon(props: { brand: Brand | null; size: number; mono?: boolean; class?: string }) {
  if (!props.brand) return null
  return <Icon name={props.brand} size={props.size} class={'pd-brand ' + (props.class || '')} />
}
