import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buttonClasses } from "@/components/ui/Button";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectDetail } from "@/components/projects/ProjectDetail";

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = await params;
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  let hasCraft = false;
  if (user) {
    const { data, error } = await client.from("craft_projects").select("project_id")
      .eq("project_id", id).eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    hasCraft = data !== null;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Detail"
        description="View and edit project stage, linked tasks, and configuration."
        actions={
          <div className="flex flex-wrap gap-2">
            {hasCraft && (
              <Link href={`/craft/${id}`} className={buttonClasses({ variant: "primary", size: "sm" })}>
                Open craft screen
              </Link>
            )}
            <Link
              href="/projects"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Back to Projects
            </Link>
          </div>
        }
      />

      <ProjectDetail id={id} />
    </div>
  );
}
