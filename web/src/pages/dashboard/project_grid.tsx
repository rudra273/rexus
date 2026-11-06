import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { type HealthCheck, type Project } from '../../api'
import { NavIcon } from '../../icons'
import { Button, cx } from '../../ui'
import { DensitySwitch } from './header'
import { GRID_COLS, GRID_MARGIN, ROW_HEIGHT, buildLayout, rowsFor, toSaved, type SavedLayout } from './layout'
import { ProjectHealthCard } from './project_card'
import { useDashboardSettings } from './settings'
import { type AllSeries, RANGES } from './shared'
import { Skel } from './skeleton'

/** Narrower than this the cards just stack in one column and can't be rearranged. */
const MIN_GRID_WIDTH = 560
const NO_LAYOUT: SavedLayout = {}

/**
 * The project cards. Wide enough, they sit on a grid: owner and admins can rearrange it ("Edit layout": drag a
 * card to move it, drag its corner to resize it) and switch comfortable / compact. That setup is saved on the
 * server, so everyone on this Rexus sees the same dashboard. Narrow, the cards stack.
 *
 * Cards are as tall as their content unless someone has dragged that card's corner.
 */
export function ProjectGrid({ projects, byProject, series, now, range, canEdit }: {
  projects: Project[]
  byProject: Map<string, HealthCheck[]>
  series: AllSeries | null
  now: number
  range: (typeof RANGES)[number]
  canEdit: boolean
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [editing, setEditing] = useState(false)
  const { settings, syncCount, saveError, update } = useDashboardSettings(canEdit, editing)
  // Bumped when the grid has to start over: after "Reset layout" or "Fit to content".
  const [restart, setRestart] = useState(0)
  // How tall each card's content is, as reported by the cards themselves.
  const [contentPx, setContentPx] = useState<Record<string, number>>({})
  const reportHeight = useCallback((id: string, px: number) => setContentPx((prev) => (prev[id] === px ? prev : { ...prev, [id]: px })), [])

  const saved = settings?.layout ?? NO_LAYOUT
  const density = settings?.density ?? 'comfortable'
  const compact = density === 'compact'
  const gridMode = mounted && width >= MIN_GRID_WIDTH
  const editingNow = canEdit && editing && gridMode
  // Hidden until every card has reported its height, so cards don't visibly jump to their real size. If that
  // somehow takes too long, they are shown anyway.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), 2000)
    return () => clearTimeout(t)
  }, [])
  const ready = gaveUp || projects.every((p) => contentPx[p.id] != null)

  // The grid only reads `layout` when it starts, so it restarts (see `key` below) whenever the layout it should
  // show changes: other projects or checks, density, a card's height in rows, a reset, or settings from elsewhere.
  const shape = projects.map((p) => `${p.id}:${(byProject.get(p.id) ?? []).length}`).join('|')
  const rows = projects.map((p) => (contentPx[p.id] != null ? rowsFor(contentPx[p.id]) : '-')).join(',')
  const layout = useMemo(
    () => buildLayout(projects.map((p) => ({ id: p.id, checks: (byProject.get(p.id) ?? []).length, contentPx: contentPx[p.id] })), saved, compact),
    // `shape` and `rows` stand in for `projects`, `byProject` and `contentPx`
    [shape, rows, saved, compact],
  )

  // After a drop or resize. Merged into what's saved, so projects hidden by the project filter keep their place.
  const save = (l: Layout, resizedId?: string) => update({ layout: { ...saved, ...toSaved(l, saved, resizedId) } })
  const fit = (id: string) => {
    update({ layout: { ...saved, [id]: { ...saved[id], auto: true } } })
    setRestart((n) => n + 1)
  }
  const reset = () => {
    update({ layout: {} })
    setRestart((n) => n + 1)
  }

  const card = (p: Project, grid: boolean) => (
    <ProjectHealthCard
      project={p}
      checks={byProject.get(p.id) ?? []}
      series={series}
      now={now}
      range={range}
      compact={compact}
      fill={grid}
      editing={grid && editingNow}
      manual={saved[p.id]?.auto === false}
      onFit={() => fit(p.id)}
      onContentHeight={grid ? (px) => reportHeight(p.id, px) : undefined}
    />
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium text-zinc-200">Projects <span className="text-zinc-400">· {projects.length}</span></h2>
        {canEdit && (
          <div className="flex items-center gap-2">
            <DensitySwitch value={density} onChange={(d) => update({ density: d })} />
            {editingNow ? (
              <>
                <Button variant="ghost" onClick={reset} className="px-2.5 py-1 text-xs">Reset layout</Button>
                <Button onClick={() => setEditing(false)} className="px-3 py-1 text-xs">Done</Button>
              </>
            ) : (
              gridMode && (
                <Button variant="secondary" onClick={() => setEditing(true)} className="px-2.5 py-1 text-xs">
                  <NavIcon name="grid" size={14} />
                  Edit layout
                </Button>
              )
            )}
          </div>
        )}
      </div>
      {editingNow && <p className="text-xs text-zinc-400">Drag a card to move it, or drag its bottom-right corner to resize it. Everyone using this Rexus sees the same layout.</p>}
      {saveError && <p role="alert" className="text-xs text-red-300">Couldn't save the layout: {saveError}</p>}
      <div ref={containerRef}>
        {!settings ? (
          <Skel className="h-48 w-full" />
        ) : (
          mounted &&
          (gridMode ? (
            <div className={cx(!ready && 'invisible')}>
              <ReactGridLayout
                key={`${shape}|${rows}|${compact}|${restart}|${syncCount}`}
                width={width}
                layout={layout}
                gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: GRID_MARGIN, containerPadding: [0, 0] }}
                dragConfig={{ enabled: editingNow, handle: '.card-drag-handle' }}
                resizeConfig={{ enabled: editingNow }}
                onDragStop={(l) => save(l)}
                onResizeStop={(l, _old, item) => save(l, item?.i)}
              >
                {projects.map((p) => (
                  <div key={p.id}>
                    <div className="h-full pb-4">{card(p, true)}</div>
                  </div>
                ))}
              </ReactGridLayout>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {projects.map((p) => (
                <div key={p.id}>{card(p, false)}</div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
