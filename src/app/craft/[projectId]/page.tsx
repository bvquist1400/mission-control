import { notFound } from "next/navigation";
import { CraftPage } from "@/components/craft/CraftPage";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) notFound();
  return <CraftPage projectId={projectId} />;
}
