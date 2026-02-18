import { permanentRedirect } from "next/navigation";

interface LegacyImplementationDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacyImplementationDetailPage({ params }: LegacyImplementationDetailPageProps) {
  const { id } = await params;
  permanentRedirect(`/applications/${id}`);
}
