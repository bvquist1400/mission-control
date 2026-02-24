import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectDetail } from "@/components/projects/ProjectDetail";

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Detail"
        description="View and edit project status, linked tasks, and configuration."
        actions={
          <Link
            href="/projects"
            className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-panel-muted"
          >
            Back to Projects
          </Link>
        }
      />

      <ProjectDetail id={id} />
    </div>
  );
}
