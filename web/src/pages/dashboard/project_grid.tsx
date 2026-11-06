import { useMemo, useState } from 'react'
import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { type HealthCheck, type Project } from '../../api'
import { NavIcon } from '../../icons'
import { Button } from '../../ui'
import { DensitySwitch } from './header'
import { GRID_COLS, GRID_MARGIN, ROW_HEIGHT, buildLayout, clearLayout, readLayout, toSaved, writeLayout, type SavedLayout } from './layout'
import { ProjectHealthCard } from './project_card'
import { type AllSeries, type CardDensity, RANGES } from './shared'

/** Narrower than this the cards just stack in one column and can't be rearranged. */
const MIN_GRID_WIDTH = 560

/**
 * The project cards. Wide enough, they sit on a grid you can rearrange ("Edit layout": drag a card to move
 * it, drag its corner to resize it); the layout is saved in this browser. Narrow, they stack.
 */
export function ProjectGrid({ projects, byProject, series, now, range, density, onDensityChange }: {
  projects: Project[]
  byProject: Map<string, HealthCheck[]>
  series: AllSeries | null
  now: number
  range: (typeof RANGES)[number]
  density: CardDensity
  onDensityChange: (d: CardDensity) => void
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<SavedLayout>(readLayout)
  const [resetCount, setResetCount] = useState(0)
  const gridMode = mounted && width >= MIN_GRID_WIDTH
  const editingNow = editing && gridMode
  const compact = density === 'compact'

  // The layout only depends on which projects there are, how many checks each has, and what's saved.
  const shape = projects.map((p) => `${p.id}:${(byProject.get(p.id) ?? []).length}`).join('|')
  const layout = useMemo(
    () => buildLayout(projects.map((p) => ({ id: p.id, checks: (byProject.get(p.id) ?? []).length })), saved, compact),
    [shape, saved, compact],
  )

  // Saved on drop / resize end. Merged into what's there, so projects hidden by the project filter keep their place.
  const save = (l: Layout) => {
    const next = { ...saved, ...toSaved(l) }
    writeLayout(next)
    setSaved(next)
  }
  const reset = () => {
    clearLayout()
    setSaved({})
    setResetCount((n) => n + 1)
  }

  const card = (p: Project, grid: boolean) => (
    <ProjectHealthCard project={p} checks={byProject.get(p.id) ?? []} series={series} now={now} range={range} compact={compact} fill={grid} editing={grid && editingNow} />
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium text-zinc-200">Projects <span className="text-zinc-400">· {projects.length}</span></h2>
        <div className="flex items-center gap-2">
          <DensitySwitch value={density} onChange={onDensityChange} />
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
      </div>
      {editingNow && <p className="text-xs text-zinc-400">Drag a card to move it, or drag its bottom-right corner to resize it. Saved in this browser.</p>}
      <div ref={containerRef}>
        {mounted &&
          (gridMode ? (
            <ReactGridLayout
              // The grid only reads `layout` when it starts, so it restarts when the default layout changes or is reset.
              key={`${shape}|${compact}|${resetCount}`}
              width={width}
              layout={layout}
              gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_MARGIN, GRID_MARGIN], containerPadding: [0, 0] }}
              dragConfig={{ enabled: editingNow, handle: '.card-drag-handle' }}
              resizeConfig={{ enabled: editingNow }}
              onDragStop={save}
              onResizeStop={save}
            >
              {projects.map((p) => (
                <div key={p.id}>{card(p, true)}</div>
              ))}
            </ReactGridLayout>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {projects.map((p) => (
                <div key={p.id}>{card(p, false)}</div>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}
