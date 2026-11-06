/** Instance look: the accent colour, applied by overriding the app's green (emerald) scale. */

const STEPS: [string, number, 'white' | 'black'][] = [
  ['50', 8, 'white'],
  ['100', 16, 'white'],
  ['200', 32, 'white'],
  ['300', 52, 'white'],
  ['400', 76, 'white'],
  ['600', 82, 'black'],
  ['700', 64, 'black'],
  ['800', 46, 'black'],
  ['900', 30, 'black'],
  ['950', 18, 'black'],
]

const ALL = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

/** Colours the whole app with this accent. An empty or invalid value restores the built-in green. */
export function applyAccent(hex: string) {
  const style = document.documentElement.style
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    for (const k of ALL) style.removeProperty(`--color-emerald-${k}`)
    return
  }
  style.setProperty('--color-emerald-500', hex)
  for (const [k, pct, base] of STEPS) {
    style.setProperty(`--color-emerald-${k}`, `color-mix(in oklab, ${hex} ${pct}%, ${base})`)
  }
}

export interface Look {
  timezone: string
  date_format: string
  accent_color: string
  logo_url: string
}

export const NO_LOOK: Look = { timezone: '', date_format: 'system', accent_color: '', logo_url: '' }
