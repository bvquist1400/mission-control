import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readIntelligenceArtifactInbox } from "@/lib/intelligence-layer/inbox";
import { queryCurrentSprintChip, type CurrentSprintChip } from "@/lib/today/queries";
import { parseSprintHolidaySet } from "@/lib/today/sprint-progress";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import type { TaskScope } from "@/lib/personal-exclusion";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;
const SPRINT_HOLIDAY_SET = parseSprintHolidaySet(process.env.NEXT_PUBLIC_SPRINT_HOLIDAYS);

function ArtifactInboxChip({ count }: { count: number }) {
  return (
    <Link
      href="/backlog?review=intelligence"
      className={`inline-flex items-center border px-2 py-1 font-mono text-xs transition pointer-coarse:min-h-11 ${
        count > 0
          ? "border-danger-border bg-danger-soft text-danger hover:bg-danger-soft-hover"
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
      href={`/backlog?sprint=${encodeURIComponent(sprint.id)}`}
      className={`inline-flex items-center border px-2 py-1 font-mono text-xs transition pointer-coarse:min-h-11 ${
        sprint.onTrack
          ? "border-success-border bg-success-soft text-success hover:bg-success-soft-hover"
          : "border-danger-border bg-danger-soft text-danger hover:bg-danger-soft-hover"
      }`}
    >
      {sprint.name} · {sprint.completedTasks}/{sprint.totalTasks} · {sprint.onTrack ? "on track" : "at risk"}
    </Link>
  );
}

export async function TodayHeaderChips({ userId, mode }: { userId: string; mode: TaskScope }) {
  const supabase = await createSupabaseServerClient();

  let openArtifactCount = 0;
  if (mode !== "personal") {
    try {
      const inbox = await readIntelligenceArtifactInbox(supabase, userId);
      openArtifactCount = inbox.counts?.open ?? 0;
    } catch (error) {
      console.error("Failed to load artifact inbox count:", error);
    }
  }

  let sprint: CurrentSprintChip | null = null;
  if (mode !== "personal") {
    try {
      sprint = await queryCurrentSprintChip(supabase, userId, TIME_ZONE, SPRINT_HOLIDAY_SET, mode);
    } catch (error) {
      console.error("Failed to load current sprint chip:", error);
    }
  }

  return (
    <>
      {mode !== "personal" ? <ArtifactInboxChip count={openArtifactCount} /> : null}
      {sprint ? <SprintChip sprint={sprint} /> : null}
    </>
  );
}
