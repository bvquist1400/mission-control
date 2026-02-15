import { PageHeader } from "@/components/layout/PageHeader";
import { TaskCard, type TaskCardData } from "@/components/tasks/TaskCard";

const topThreeTasks: TaskCardData[] = [
  {
    id: "task-1",
    title: "Lock intake extraction schema for service desk emails",
    estimatedMinutes: 60,
    dueAt: "2026-02-16",
    status: "Next",
    blocker: false,
    implementationName: "Service Desk Automation",
  },
  {
    id: "task-2",
    title: "Review API route contracts with backend handoff notes",
    estimatedMinutes: 45,
    dueAt: "2026-02-16",
    status: "Next",
    blocker: false,
    implementationName: "Mission Control Core",
  },
  {
    id: "task-3",
    title: "Draft leadership update copy for payroll rollout",
    estimatedMinutes: 30,
    dueAt: "2026-02-17",
    status: "Scheduled",
    blocker: true,
    implementationName: "Payroll Modernization",
  },
];

const dueSoonTasks: TaskCardData[] = [
  {
    id: "task-4",
    title: "Validate triage defaults against latest SQL migration",
    estimatedMinutes: 30,
    dueAt: "2026-02-16",
    status: "Scheduled",
    blocker: false,
    implementationName: "Mission Control Core",
  },
  {
    id: "task-5",
    title: "Confirm training docs are linked in implementation detail",
    estimatedMinutes: 15,
    dueAt: "2026-02-17",
    status: "Waiting",
    blocker: false,
    implementationName: "Payroll Modernization",
  },
];

const waitingOn = [
  { id: "wait-1", title: "Security review sign-off", owner: "InfoSec", followUpAt: "2026-02-18" },
  { id: "wait-2", title: "Updated target date from vendor", owner: "Vendor PM", followUpAt: "2026-02-19" },
];

const needsReview = [
  "New intake item tagged with two possible implementations",
  "Missing estimate on high-priority ticket from Friday batch",
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

export default function TodayPage() {
  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  return (
    <div className="space-y-8">
      <PageHeader
        title="Today"
        description="Daily operating view with top priorities, near-term due work, and review queue."
        actions={<p className="rounded-full bg-panel-muted px-3 py-1.5 text-sm font-medium text-muted-foreground">{today}</p>}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Top 3 Today</h2>
        <div className="grid gap-4 xl:grid-cols-3">
          {topThreeTasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Due Soon (48h)</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {dueSoonTasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">Waiting On</h2>
          <ul className="mt-4 space-y-3">
            {waitingOn.map((item) => (
              <li key={item.id} className="rounded-lg bg-panel-muted p-3 text-sm">
                <p className="font-medium text-foreground">{item.title}</p>
                <p className="mt-1 text-muted-foreground">
                  {item.owner} · follow up {formatDate(item.followUpAt)}
                </p>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">Needs Review</h2>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {needsReview.map((item) => (
              <li key={item} className="rounded-lg bg-panel-muted px-3 py-2">
                {item}
              </li>
            ))}
          </ul>
          <a
            href="/triage"
            className="mt-4 inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Open Triage
          </a>
        </article>
      </section>
    </div>
  );
}
