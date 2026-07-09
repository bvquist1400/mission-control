import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readIntelligenceArtifactInbox } from "@/lib/intelligence-layer/inbox";
import { queryCurrentSprintChip, type CurrentSprintChip } from "@/lib/today/queries";
import { parseSprintHolidaySet } from "@/lib/today/sprint-progress";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;
const SPRINT_HOLIDAY_SET = parseSprintHolidaySet(process.env.NEXT_PUBLIC_SPRINT_HOLIDAYS);

function ArtifactInboxChip({ count }: { count: number }) {
  return (
    <Link
      href="/backlog?review=intelligence"
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        count > 0
          ? "border-red-500/30 bg-red-500/10 text-red-300 hover:border-red-400/40 hover:bg-red-500/15"
          : "border-stroke bg-panel text-muted-foreground hover:bg-panel-muted hover:text-foreground"
      }`}
    >
      Artifact Inbox ({count})
    </Link>
  );
}

function SprintChip({ sprint }: { sprint: CurrentSprintChip }) {
  return (
    <Link
      href={`/sprints/${sprint.id}`}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        sprint.onTrack
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
          : "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/15"
      }`}
    >
      {sprint.name} · {sprint.completedTasks}/{sprint.totalTasks} · {sprint.onTrack ? "on track" : "at risk"}
    </Link>
  );
}

export async function TodayHeaderChips({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();

  let openArtifactCount = 0;
  try {
    const inbox = await readIntelligenceArtifactInbox(supabase, userId);
    openArtifactCount = inbox.counts?.open ?? 0;
  } catch (error) {
    console.error("Failed to load artifact inbox count:", error);
  }

  let sprint: CurrentSprintChip | null = null;
  try {
    sprint = await queryCurrentSprintChip(supabase, userId, TIME_ZONE, SPRINT_HOLIDAY_SET);
  } catch (error) {
    console.error("Failed to load current sprint chip:", error);
  }

  return (
    <>
      <ArtifactInboxChip count={openArtifactCount} />
      {sprint ? <SprintChip sprint={sprint} /> : null}
    </>
  );
}
