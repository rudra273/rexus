import type { Layout, LayoutItem } from 'react-grid-layout'

/** The project grid: 12 columns, 24px rows, 16px gaps. */
export const GRID_COLS = 12
export const ROW_HEIGHT = 24
export const GRID_MARGIN = 16
const MIN_W = 4
const MIN_H = 4
const KEY = 'rexus.dashboard.layout'

/** Where one card sits, in grid units. */
export interface Placement {
  x: number
  y: number
  w: number
  h: number
}
/** Saved placements by project id. Lives in this browser only (localStorage), like the other view settings. */
export type SavedLayout = Record<string, Placement>

export function readLayout(): SavedLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Placement>
    const out: SavedLayout = {}
    for (const [id, v] of Object.entries(raw)) {
      if (v && [v.x, v.y, v.w, v.h].every((n) => Number.isFinite(n))) out[id] = { x: v.x, y: v.y, w: v.w, h: v.h }
    }
    return out
  } catch {
    return {}
  }
}

export function writeLayout(l: SavedLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* private mode: the layout still applies until reload */
  }
}

export function clearLayout() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Pixel height a project card needs to show `checks` rows without scrolling (rough, on the generous side). */
export function neededHeight(checks: number, dense: boolean): number {
  return dense ? 130 + 36 * Math.min(checks, 6) + (checks > 6 ? 24 : 0) : 130 + 104 * checks
}

/** Grid rows that give at least `px` pixels. */
function rowsFor(px: number): number {
  return Math.max(MIN_H, Math.ceil((px + GRID_MARGIN) / (ROW_HEIGHT + GRID_MARGIN)))
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/**
 * The layout to show: saved placements where there are any; new projects go below them, two per row (a
 * lone one takes the full width), sized to their number of checks.
 */
export function buildLayout(projects: { id: string; checks: number }[], saved: SavedLayout, dense: boolean): LayoutItem[] {
  const fresh = projects.filter((p) => !saved[p.id]).length
  let k = 0
  return projects.map((p) => {
    const s = saved[p.id]
    if (s) {
      const w = clamp(s.w, MIN_W, GRID_COLS)
      return { i: p.id, x: clamp(s.x, 0, GRID_COLS - w), y: Math.max(0, s.y), w, h: Math.max(MIN_H, s.h), minW: MIN_W, minH: MIN_H }
    }
    const n = k++
    const alone = n === fresh - 1 && n % 2 === 0
    // y is far down on purpose: the grid packs everything upwards, which keeps the order.
    return { i: p.id, x: alone ? 0 : (n % 2) * (GRID_COLS / 2), y: 100_000 + Math.floor(n / 2) * 1000, w: alone ? GRID_COLS : GRID_COLS / 2, h: rowsFor(neededHeight(p.checks, dense)), minW: MIN_W, minH: MIN_H }
  })
}

export function toSaved(layout: Layout): SavedLayout {
  const out: SavedLayout = {}
  for (const it of layout) out[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h }
  return out
}
