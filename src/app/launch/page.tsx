import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { CardSkeleton } from "@/components/ui/Card";
import { LaunchPageBody } from "@/components/launch/LaunchPage";
import { RefreshButton } from "@/components/launch/LaunchManualPanels";
import { buildLaunchView, loadLaunchPageInput } from "@/lib/launch-metrics/page-data";
import { readVercelAnalyticsConfig } from "@/lib/launch-metrics/vercel-analytics";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function LaunchContent({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  // Only the token's expiry date is read here (to warn a month ahead); the
  // token itself never leaves the server-side sync.
  const tokenExpires = readVercelAnalyticsConfig(process.env)?.tokenExpires ?? null;
  const now = new Date();
  const input = await loadLaunchPageInput(supabase, userId, tokenExpires).catch(() => null);
  if (!input) {
    return (
      <p role="alert" className="rounded-card border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger">
        The launch numbers could not be read from Baseline right now. Try again in a minute.
      </p>
    );
  }
  return <LaunchPageBody view={buildLaunchView(input, now)} input={input} now={now} />;
}

function LaunchSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <CardSkeleton key={index} padding="sm" className="h-28" />
        ))}
      </div>
      <CardSkeleton className="h-72" />
    </div>
  );
}

export default async function LaunchPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Menu & Market launch numbers"
        description="Counts only: no account is listed by name, email or id. Sign-ups use New York days, the website UTC days, Google search Pacific days."
        actions={<RefreshButton />}
      />
      <Suspense fallback={<LaunchSkeleton />}>
        <LaunchContent userId={user.id} />
      </Suspense>
    </div>
  );
}
