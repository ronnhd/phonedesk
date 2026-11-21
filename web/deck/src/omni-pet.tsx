import { useEffect, useRef, useState } from 'preact/hooks'
import { reducedMotion } from './knowns'
import type { PushedValue } from './types'

type PetState = 'busy' | 'idle' | 'sleep'

const THOUGHTS: Record<PetState, string[]> = {
  busy: ['dang dot token ne!', 'woof woof!', 'co request moi!'],
  idle: ['chan...', 'an gi khong?', 'doi agent ti...'],
  sleep: ['zzz...', 'mo thay xuong...'],
}

let audio: AudioContext | null = null
let lastSound = 0

function unlockAudio() {
  try {
    if (!audio) audio = new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
  } catch {
    audio = null
  }
}

function bark() {
  if (!audio || audio.state !== 'running') return
  if (Date.now() - lastSound < 120_000) return
  lastSound = Date.now()
  const ctx = audio
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(520, t)
  osc.frequency.exponentialRampToValueAtTime(260, t + 0.13)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t)
  osc.stop(t + 0.18)
}

export function OmniPet(props: { val?: PushedValue; size?: number }) {
  const raw = String(props.val?.value || 'idle')
  const state: PetState = raw === 'busy' || raw === 'sleep' ? raw : 'idle'
  const size = props.size || 44
  const [bubble, setBubble] = useState('')
  const hide = useRef<number | undefined>(undefined)

  useEffect(() => {
    document.addEventListener('pointerdown', unlockAudio, { once: true })
    return () => document.removeEventListener('pointerdown', unlockAudio)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (Math.random() > 0.3) return
      const list = THOUGHTS[state]
      setBubble(list[Math.floor(Math.random() * list.length)])
      if (hide.current) window.clearTimeout(hide.current)
      hide.current = window.setTimeout(() => setBubble(''), 2600)
      if (Math.random() < 0.25) bark()
    }, 9000)
    return () => {
      window.clearInterval(id)
      if (hide.current) window.clearTimeout(hide.current)
    }
  }, [state])

  const cls = 'pd-pet pd-pet--' + state + (reducedMotion() ? ' pd-pet--still' : '')
  return (
    <span class={cls} style={{ width: size + 'px', height: size + 'px' }} title={props.val?.sub || 'OmniRoute activity'}>
      {bubble ? <span class="pd-pet__bubble">{bubble}</span> : null}
      {state === 'sleep' ? <span class="pd-pet__zzz">z z z</span> : null}
      <svg class="pd-pet__svg" viewBox="0 0 64 64" aria-hidden="true">
        <g class="pd-pet__tail">
          <path d="M45 45 C57 45 59 31 51 27 C46 24 43 29 47 32" fill="none" stroke="#e89b3c" stroke-width="7" stroke-linecap="round" />
        </g>
        <ellipse cx="32" cy="45" rx="16" ry="14" fill="#f2bf76" />
        <ellipse cx="32" cy="49" rx="10" ry="8" fill="#fff0d6" />
        <path d="M17 20 L15 6 L27 14 Z" fill="#e89b3c" />
        <path d="M47 20 L49 6 L37 14 Z" fill="#e89b3c" />
        <path d="M17 18 L18 11 L24 15 Z" fill="#f7c7a8" />
        <path d="M47 18 L46 11 L40 15 Z" fill="#f7c7a8" />
        <circle cx="32" cy="28" r="18" fill="#f7c986" />
        <ellipse cx="32" cy="35" rx="11" ry="8" fill="#fff3df" />
        <g class="pd-pet__eyes">
          <circle class="pd-pet__eye pd-pet__eye--open" cx="25" cy="27" r="2.6" fill="#2c2118" />
          <circle class="pd-pet__eye pd-pet__eye--open" cx="39" cy="27" r="2.6" fill="#2c2118" />
          <path class="pd-pet__eye pd-pet__eye--sleep" d="M22 27 Q25 30 28 27 M36 27 Q39 30 42 27" fill="none" stroke="#2c2118" stroke-width="2" stroke-linecap="round" />
        </g>
        <ellipse cx="32" cy="33" rx="3.2" ry="2.4" fill="#2c2118" />
        <path d="M32 35 Q29 39 26 36 M32 35 Q35 39 38 36" fill="none" stroke="#2c2118" stroke-width="1.6" stroke-linecap="round" />
        <ellipse cx="19" cy="33" rx="3" ry="1.8" fill="#ef9b8d" opacity="0.65" />
        <ellipse cx="45" cy="33" rx="3" ry="1.8" fill="#ef9b8d" opacity="0.65" />
      </svg>
    </span>
  )
}
