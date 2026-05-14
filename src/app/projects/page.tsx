import { ProjectsList } from "@/components/projects/ProjectsList";

interface ProjectsPageProps {
  searchParams?: Promise<{
    implementation_id?: string;
  }>;
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const implementationId = resolvedSearchParams?.implementation_id;

  return <ProjectsList implementationId={implementationId} defaultView="table" />;
}
