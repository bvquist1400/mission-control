import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/legacy-redirects";

interface LegacyStakeholderDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacyStakeholderDetailPage({ params }: LegacyStakeholderDetailPageProps) {
  const { id } = await params;
  redirect(legacyRedirectTarget("stakeholder-detail", id));
}
