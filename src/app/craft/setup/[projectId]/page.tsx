import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { loadCraftSetupPreview } from "@/lib/craft/setup-service";
import { CraftSetupScreen } from "@/components/craft/CraftSetupScreen";
import { buttonClasses } from "@/components/ui/Button";
export const dynamic = "force-dynamic";
/** S1C: a read-only preview of what "Set up craft screen" makes. Nothing is written until Create. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) notFound();
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  let preview;
  try {
    preview = await loadCraftSetupPreview(client, user.id, projectId);
  } catch (error) {
    if (!isPostgrestNotFound(error as { code: string } | null)) throw error;
    return <main className="mx-auto max-w-xl px-4 py-8"><Link href="/projects" className={buttonClasses({ variant: "secondary", size: "sm" })}>← Back to projects</Link><h1 className="mt-8 text-2xl font-bold">Project not found</h1></main>;
  }
  return <CraftSetupScreen key={preview.fingerprint} projectId={projectId} plan={preview.plan} fingerprint={preview.fingerprint} />;
}
