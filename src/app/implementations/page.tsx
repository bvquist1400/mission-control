import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImplementationCard, type ImplementationCardData } from "@/components/implementations/ImplementationCard";

const implementations: ImplementationCardData[] = [
  {
    id: "impl-1",
    name: "Service Desk Automation",
    phase: "Build",
    rag: "Yellow",
    targetDate: "2026-03-01",
    nextMilestone: "Pilot launch with support leads",
    nextMilestoneDate: "2026-02-22",
    statusSummary: "Build is on track, but one vendor API dependency is unresolved.",
    blockersCount: 1,
    nextAction: "Resolve vendor authentication blocker and re-run end-to-end test.",
  },
  {
    id: "impl-2",
    name: "Payroll Modernization",
    phase: "Training",
    rag: "Green",
    targetDate: "2026-02-28",
    nextMilestone: "Manager enablement walkthrough",
    nextMilestoneDate: "2026-02-20",
    statusSummary: "No critical risks; training prep is in final review.",
    blockersCount: 0,
    nextAction: "Publish final FAQ and confirm attendance with HR leads.",
  },
];

export default function ImplementationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Implementations"
        description="Portfolio snapshot for execution health, milestones, blockers, and ready-to-send status updates."
      />

      <section className="grid gap-4 xl:grid-cols-2">
        {implementations.map((implementation) => (
          <div key={implementation.id} className="space-y-2">
            <ImplementationCard implementation={implementation} />
            <Link
              href={`/implementations/${implementation.id}`}
              className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              Open details
            </Link>
          </div>
        ))}
      </section>
    </div>
  );
}
