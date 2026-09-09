import Link from "next/link";
import { TASK_SCOPE_VALUES, type TaskScope } from "@/lib/personal-exclusion";

const MODE_LABELS: Record<TaskScope, string> = {
  work: "Work",
  personal: "Personal",
  all: "All",
};

const MODE_DESCRIPTIONS: Record<TaskScope, string> = {
  work: "Showing work tasks. Personal tasks and projects stay out of this view.",
  personal: "Showing personal tasks and tasks inherited from personal projects.",
  all: "Showing work and personal tasks together.",
};

export function TodayModeToggle({ mode }: { mode: TaskScope }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-stroke bg-panel px-4 py-3 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today mode</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{MODE_DESCRIPTIONS[mode]}</p>
      </div>
      <nav aria-label="Filter Today tasks" className="inline-flex rounded-lg border border-stroke bg-panel-muted p-1">
        {TASK_SCOPE_VALUES.map((value) => (
          <Link
            key={value}
            href={`/?mode=${value}`}
            aria-current={mode === value ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${
              mode === value
                ? "bg-accent text-white shadow-sm"
                : "text-muted-foreground hover:bg-panel hover:text-foreground"
            }`}
          >
            {MODE_LABELS[value]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
