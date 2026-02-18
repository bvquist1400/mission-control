"use client";

interface TaskProgressBarProps {
  completedCount: number;
  totalCount: number;
  completedMinutes: number;
  remainingMinutes: number;
  percentComplete: number;
}

export function TaskProgressBar({
  completedCount,
  totalCount,
  completedMinutes,
  remainingMinutes,
  percentComplete,
}: TaskProgressBarProps) {
  const totalMinutes = completedMinutes + remainingMinutes;

  return (
    <div className="rounded-lg border border-stroke bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Progress</h3>
        <span className="text-sm font-medium text-foreground">{percentComplete}%</span>
      </div>

      {/* Progress bar */}
      <div className="relative mb-3 h-3 overflow-hidden rounded-full bg-panel-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-green-500 transition-all duration-500"
          style={{ width: `${percentComplete}%` }}
        />
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <span className="text-green-400">{completedCount}</span>
          <span className="text-muted-foreground"> of </span>
          <span className="text-foreground">{totalCount}</span>
          <span className="text-muted-foreground"> tasks</span>
        </div>
        <div>
          <span className="text-green-400">{completedMinutes}</span>
          <span className="text-muted-foreground"> of </span>
          <span className="text-foreground">{totalMinutes}</span>
          <span className="text-muted-foreground"> min</span>
        </div>
        {remainingMinutes > 0 && (
          <div>
            <span className="text-yellow-400">{remainingMinutes} min</span>
            <span className="text-muted-foreground"> remaining</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface CompactProgressProps {
  completedCount: number;
  totalCount: number;
  percentComplete: number;
}

export function CompactProgress({ completedCount, totalCount, percentComplete }: CompactProgressProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-2 w-24 overflow-hidden rounded-full bg-panel-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-green-500"
          style={{ width: `${percentComplete}%` }}
        />
      </div>
      <span className="text-sm text-muted-foreground">
        {completedCount}/{totalCount} tasks ({percentComplete}%)
      </span>
    </div>
  );
}
