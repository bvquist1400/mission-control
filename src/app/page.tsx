import { Suspense } from "react";
import { redirect } from "next/navigation";
import { WeekBoardSection } from "@/components/today/sections/WeekBoardSection";
import { TodayHeaderChips } from "@/components/today/sections/TodayHeaderChips";
import { SectionSkeleton } from "@/components/today/sections/SectionSkeleton";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeTaskScope } from "@/lib/personal-exclusion";

export const dynamic = "force-dynamic";

/**
 * Today, board first (redesign S4; Brent 11/5: "I do use the weekly board a
 * lot. I dont really utalize the "todays meetings" or "now" section."): one
 * line under the menu (date, next meeting, colour key), then the week board
 * with Overdue and Waiting in a side rail. Tasks open in the app-wide task
 * panel (S3, TaskPanelProvider in AppShell); the board narrows beside it.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const mode = normalizeTaskScope(
    Array.isArray(resolvedSearchParams.mode) ? resolvedSearchParams.mode[0] : resolvedSearchParams.mode,
    "work"
  );
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <Suspense fallback={<SectionSkeleton label="weekly board" />}>
      <WeekBoardSection
        userId={user.id}
        mode={mode}
        chips={
          <Suspense fallback={null}>
            <TodayHeaderChips userId={user.id} mode={mode} />
          </Suspense>
        }
      />
    </Suspense>
  );
}
