import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { PhaseBadge } from "@/components/ui/PhaseBadge";
import { RagBadge } from "@/components/ui/RagBadge";

interface ImplementationDetailPageProps {
  params: Promise<{ id: string }>;
}

const detailCards = [
  { label: "Target Date", value: "Feb 28, 2026" },
  { label: "Next Milestone", value: "Manager enablement walkthrough" },
  { label: "Milestone Date", value: "Feb 20, 2026" },
  { label: "Open Blockers", value: "0" },
];

export default async function ImplementationDetailPage({ params }: ImplementationDetailPageProps) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Implementation ${id}`}
        description="Detail editing, linked tasks, and status update log live here in WP6."
        actions={
          <Link href="/implementations" className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-panel-muted">
            Back to all
          </Link>
        }
      />

      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <PhaseBadge phase="Training" />
          <RagBadge status="Green" />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {detailCards.map((card) => (
            <article key={card.label} className="rounded-lg bg-panel-muted p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{card.label}</p>
              <p className="mt-1 text-sm font-medium text-foreground">{card.value}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
