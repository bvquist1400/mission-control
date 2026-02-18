import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImplementationDetail } from "@/components/implementations/ImplementationDetail";

interface ImplementationDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ImplementationDetailPage({ params }: ImplementationDetailPageProps) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Application Detail"
        description="View and edit application status, linked tasks, and status history."
        actions={
          <Link href="/applications" className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-panel-muted">
            Back to all
          </Link>
        }
      />

      <ImplementationDetail id={id} />
    </div>
  );
}
