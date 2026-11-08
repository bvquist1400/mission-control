import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { CraftNotFoundError, loadCraftView } from "@/lib/craft/loader";
import { CraftScreen } from "@/components/craft/CraftScreen";
import { buttonClasses } from "@/components/ui/Button";

export async function CraftPage({ projectId }: { projectId?: string }) {
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  let view;
  try {
    view = await loadCraftView(client, user.id, projectId);
  } catch (error) {
    if (!(error instanceof CraftNotFoundError) && !isPostgrestNotFound(error as { code: string } | null)) throw error;
    return <main className="mx-auto max-w-xl px-4 py-8"><Link href="/projects" className={buttonClasses({ variant: "secondary", size: "sm" })}>← Back to projects</Link><h1 className="mt-8 text-2xl font-bold">No craft project yet</h1><p className="mt-3 text-muted-foreground">Craft projects will appear here once they are set up.</p></main>;
  }
  return <CraftScreen view={view} />;
}
