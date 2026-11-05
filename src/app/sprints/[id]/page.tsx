import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/legacy-redirects";

interface LegacySprintDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacySprintDetailPage({ params }: LegacySprintDetailPageProps) {
  const { id } = await params;
  redirect(legacyRedirectTarget("sprint-detail", id));
}
