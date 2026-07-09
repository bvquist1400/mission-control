export function SectionSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="animate-pulse rounded-card border border-stroke bg-panel p-5 shadow-sm"
      aria-hidden="true"
    >
      {label ? (
        <span className="sr-only">Loading {label}…</span>
      ) : null}
      <div className="h-4 w-40 rounded bg-panel-muted" />
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full rounded bg-panel-muted" />
        <div className="h-3 w-2/3 rounded bg-panel-muted" />
      </div>
    </div>
  );
}
