import type { Layout, LayoutItem } from 'react-grid-layout'

/**
 * The project grid: 12 columns with 16px between them, and thin 4px rows, so a card can be almost exactly as
 * tall as its content. There is no vertical margin in the grid itself; each card carries its own gap below it
 * (`CARD_GAP`) as part of its height.
 */
export const GRID_COLS = 12
export const ROW_HEIGHT = 4
export const GRID_MARGIN: [number, number] = [16, 0]
export const CARD_GAP = 16
const MIN_W = 4
const MIN_H = 30 // 120px
/** Padding and border around a card's content, in px. */
export const CARD_CHROME = 34

/**
 * Where one card sits, in grid units. `auto`: the height follows the card's content (the default);
 * otherwise `h` is a height someone set by dragging the card's corner.
 */
export interface Placement {
  x: number
  y: number
  w: number
  h: number
  auto: boolean
}
/** Placements by project id. Shared by everyone on this Rexus, stored on the server. */
export type SavedLayout = Record<string, Placement>

/** Rough pixel height a card needs for `checks` rows. Only used until the real height has been measured. */
export function neededHeight(checks: number, dense: boolean): number {
  return dense ? 130 + 36 * Math.min(checks, 6) + (checks > 6 ? 24 : 0) : 130 + 104 * checks
}

/** Grid rows for a card whose content is `px` tall, including the gap below it. */
export function rowsFor(px: number): number {
  return Math.max(MIN_H, Math.ceil((px + CARD_GAP) / ROW_HEIGHT))
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/**
 * The layout to show: saved positions where there are any; new projects go below them, two per row (a lone
 * one takes the full width). A card's height is its measured content (`contentPx`), unless someone set it by
 * hand.
 */
export function buildLayout(projects: { id: string; checks: number; contentPx?: number }[], saved: SavedLayout, dense: boolean): LayoutItem[] {
  const fresh = projects.filter((p) => !saved[p.id]).length
  let k = 0
  return projects.map((p) => {
    const fit = rowsFor(p.contentPx ?? neededHeight(p.checks, dense))
    const s = saved[p.id]
    if (s) {
      const w = clamp(s.w, MIN_W, GRID_COLS)
      return { i: p.id, x: clamp(s.x, 0, GRID_COLS - w), y: Math.max(0, s.y), w, h: s.auto ? fit : Math.max(MIN_H, s.h), minW: MIN_W, minH: MIN_H }
    }
    const n = k++
    const alone = n === fresh - 1 && n % 2 === 0
    // y is far down on purpose: the grid packs everything upwards, which keeps the order.
    return { i: p.id, x: alone ? 0 : (n % 2) * (GRID_COLS / 2), y: 100_000 + Math.floor(n / 2) * 1000, w: alone ? GRID_COLS : GRID_COLS / 2, h: fit, minW: MIN_W, minH: MIN_H }
  })
}

/**
 * What to save after a drag or resize. Cards keep their "height follows content" setting; the card whose
 * corner was just dragged (`resizedId`) is now fixed at the height it was given.
 */
export function toSaved(layout: Layout, prev: SavedLayout, resizedId?: string): SavedLayout {
  const out: SavedLayout = {}
  for (const it of layout) {
    const manual = it.i === resizedId || prev[it.i]?.auto === false
    out[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h, auto: !manual }
  }
  return out
}
