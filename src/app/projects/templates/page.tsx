import { ProjectTemplatesPage } from "@/components/projects/ProjectTemplatesPage";

interface TemplatesPageProps {
  searchParams?: Promise<{
    mode?: string;
    template_id?: string;
  }>;
}

export default async function TemplatesPage({ searchParams }: TemplatesPageProps) {
  const resolved = searchParams ? await searchParams : undefined;
  const modeParam = resolved?.mode;
  const initialMode = modeParam === "create" || modeParam === "edit" ? modeParam : "browse";
  const initialTemplateId = resolved?.template_id;

  return (
    <ProjectTemplatesPage
      initialMode={initialMode}
      initialTemplateId={initialTemplateId}
    />
  );
}
