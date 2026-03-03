import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { SprintDetail } from "@/components/sprints/SprintDetail";

interface SprintDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function SprintDetailPage({ params }: SprintDetailPageProps) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sprint Detail"
        description="Review sprint scope, completion progress, and task status distribution."
        actions={
          <Link
            href="/sprints"
            className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-panel-muted"
          >
            Back to Sprints
          </Link>
        }
      />

      <SprintDetail id={id} />
    </div>
  );
}
