import { createSupabaseServerClient } from "@/lib/supabase/server";
import { queryWaitingSummary } from "@/lib/today/queries";
import { WaitingStrip } from "@/components/today/sections/WaitingStrip";
import type { TaskScope } from "@/lib/personal-exclusion";

export async function WaitingStripSection({ userId, mode }: { userId: string; mode: TaskScope }) {
  const supabase = await createSupabaseServerClient();

  let tasks;
  try {
    tasks = await queryWaitingSummary(supabase, userId, 8, mode);
  } catch (error) {
    console.error("Failed to load blocked/waiting strip:", error);
    return null;
  }

  // No empty section: render nothing when nothing is blocked.
  if (tasks.length === 0) {
    return null;
  }

  return <WaitingStrip tasks={tasks} />;
}
