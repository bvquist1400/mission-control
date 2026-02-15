import { PageHeader } from "@/components/layout/PageHeader";

const triageTasks = [
  {
    id: "triage-1",
    title: "Customer escalation: provisioning delay in onboarding flow",
    implementation: "Service Desk Automation",
    estimate: 60,
    status: "Next",
    dueAt: "2026-02-16",
  },
  {
    id: "triage-2",
    title: "FYI thread from finance about invoice coding updates",
    implementation: "Unassigned",
    estimate: 15,
    status: "Scheduled",
    dueAt: "2026-02-18",
  },
];

export default function TriagePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Triage"
        description="Tasks that need assignment, estimate, or scheduling decisions before entering execution lanes."
      />

      <section className="rounded-card border border-stroke bg-panel shadow-sm">
        <div className="grid grid-cols-[2fr_1.2fr_.8fr_.9fr_1fr] gap-3 border-b border-stroke px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Task</span>
          <span>Implementation</span>
          <span>Estimate</span>
          <span>Status</span>
          <span>Due</span>
        </div>

        <ul className="divide-y divide-stroke">
          {triageTasks.map((task) => (
            <li key={task.id} className="grid grid-cols-[2fr_1.2fr_.8fr_.9fr_1fr] gap-3 px-4 py-4 text-sm">
              <span className="font-medium text-foreground">{task.title}</span>
              <span className="text-muted-foreground">{task.implementation}</span>
              <span className="text-muted-foreground">{task.estimate} min</span>
              <span className="text-muted-foreground">{task.status}</span>
              <span className="text-muted-foreground">{task.dueAt}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-sm text-muted-foreground">
        Next step: wire this page to `TriageList`, `TriageRow`, and optimistic updates from Supabase.
      </p>
    </div>
  );
}
