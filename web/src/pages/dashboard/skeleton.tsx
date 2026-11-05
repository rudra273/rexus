import { Card, PageHeader, cx } from '../../ui'

/** A pulsing grey block that holds the space of content that hasn't arrived yet, so the page doesn't jump. */
export function Skel({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-zinc-800/70', className)} aria-hidden="true" />
}

/** Shown until the first answer arrives: same grid as the real page, so the layout is already in place. */
export function DashboardSkeleton() {
  return (
    <div role="status" aria-label="Loading dashboard">
      <PageHeader title="Dashboard" subtitle={<Skel className="h-4 w-40" />} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="px-4 py-3">
            <Skel className="h-3 w-24" />
            <Skel className="mt-3 h-7 w-20" />
            <Skel className="mt-3 h-3 w-32" />
            <Skel className="mt-3 h-1.5 w-full rounded-full" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="p-4">
              <Skel className="h-5 w-40" />
              <Skel className="mt-6 h-4 w-full" />
              <Skel className="mt-3 h-16 w-full" />
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="px-4 py-3"><Skel className="h-5 w-44" /></Card>
          ))}
        </div>
      </div>
    </div>
  )
}
