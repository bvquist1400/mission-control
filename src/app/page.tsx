import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { FocusStatusBar } from "@/components/today/FocusStatusBar";
import { TodayModalProvider } from "@/components/today/TodayModalProvider";
import { MeetingsSection } from "@/components/today/sections/MeetingsSection";
import { NowPanelSection } from "@/components/today/sections/NowPanelSection";
import { WeekBoardSection } from "@/components/today/sections/WeekBoardSection";
import { TodayHeaderChips } from "@/components/today/sections/TodayHeaderChips";
import { SectionSkeleton } from "@/components/today/sections/SectionSkeleton";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

export const dynamic = "force-dynamic";

function HeaderChipsFallback() {
  return (
    <span
      aria-hidden="true"
      className="h-8 w-28 animate-pulse rounded-full bg-panel-muted"
    />
  );
}

export default async function TodayPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_WORKDAY_CONFIG.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  return (
    <div className="space-y-8">
      <PageHeader
        title="Today"
        description="Quick-view dashboard for meetings, priorities, and near-term execution risk."
        actions={
          <div className="flex items-center gap-3">
            <Suspense fallback={<HeaderChipsFallback />}>
              <TodayHeaderChips userId={user.id} />
            </Suspense>
            <p className="rounded-full bg-panel-muted px-3 py-1.5 text-sm font-medium text-muted-foreground">
              {today}
            </p>
          </div>
        }
      />

      <FocusStatusBar />

      <TodayModalProvider>
        <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <Suspense fallback={<SectionSkeleton label="now panel" />}>
            <NowPanelSection userId={user.id} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton label="today's meetings" />}>
            <MeetingsSection userId={user.id} />
          </Suspense>
        </section>

        <Suspense fallback={<SectionSkeleton label="weekly board" />}>
          <WeekBoardSection userId={user.id} />
        </Suspense>
      </TodayModalProvider>
    </div>
  );
}
