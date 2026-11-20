import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { CraftSetupRefusal, loadCraftResetPreview, loadCraftSetupPreview } from "@/lib/craft/setup-service";
import { CraftSetupScreen } from "@/components/craft/CraftSetupScreen";
import { buttonClasses } from "@/components/ui/Button";
export const dynamic = "force-dynamic";
/** S1C: a read-only preview of what "Set up craft screen" makes. Nothing is written until Create. S4: `?reset=1` is
 * the Reset preview (the craft screen menu's "Reset craft screen"); nothing changes until Reset is confirmed. */
export default async function Page({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { projectId } = await params;
  const isReset = (await searchParams).reset === "1";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) notFound();
  const client = await createSupabaseServerClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  let preview: Awaited<ReturnType<typeof loadCraftSetupPreview>> | null = null;
  let resetPreview: Awaited<ReturnType<typeof loadCraftResetPreview>> | null = null;
  let refusal: string | null = null;
  try {
    if (isReset) resetPreview = await loadCraftResetPreview(client, user.id, projectId);
    else preview = await loadCraftSetupPreview(client, user.id, projectId);
  } catch (error) {
    if (error instanceof CraftSetupRefusal) refusal = error.message;
    else if (!isPostgrestNotFound(error as { code: string } | null)) throw error;
  }
  if (refusal !== null) {
    return <main className="mx-auto max-w-xl px-4 py-8"><Link href={`/craft/${projectId}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>← Back</Link><p className="mt-8">{refusal}</p></main>;
  }
  if (resetPreview) {
    const { plan, fingerprint, ...reset } = resetPreview;
    return <CraftSetupScreen key={fingerprint} projectId={projectId} plan={plan} fingerprint={fingerprint} reset={reset} />;
  }
  if (!preview) {
    return <main className="mx-auto max-w-xl px-4 py-8"><Link href="/projects" className={buttonClasses({ variant: "secondary", size: "sm" })}>← Back to projects</Link><h1 className="mt-8 text-2xl font-bold">Project not found</h1></main>;
  }
  return <CraftSetupScreen key={preview.fingerprint} projectId={projectId} plan={preview.plan} fingerprint={preview.fingerprint} />;
}
