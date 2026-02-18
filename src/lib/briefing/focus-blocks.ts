/**
 * Focus block calculation for Daily Briefing
 * Identifies available time slots between meetings for focused work
 */

import type { BusyBlock, CalendarDayWindow } from "@/lib/calendar";

export interface FocusBlock {
  start_at: string;
  end_at: string;
  minutes: number;
  suitableFor: "deep" | "shallow" | "prep";
}

/**
 * Classify a focus block based on its duration
 * - deep: 45+ minutes (focused, uninterrupted work)
 * - shallow: 20-44 minutes (quick tasks, emails, reviews)
 * - prep: <20 minutes (very short tasks only)
 */
function classifyFocusBlock(minutes: number): FocusBlock["suitableFor"] {
  if (minutes >= 45) return "deep";
  if (minutes >= 20) return "shallow";
  return "prep";
}

/**
 * Calculate available focus blocks from busy blocks and day windows
 * Returns gaps between meetings that fall within the work window
 */
export function calculateFocusBlocks(
  busyBlocks: BusyBlock[],
  windows: CalendarDayWindow[],
  nowMs?: number
): FocusBlock[] {
  const focusBlocks: FocusBlock[] = [];

  for (const window of windows) {
    // Get busy blocks for this day
    const dayBusyBlocks = busyBlocks
      .filter((block) => {
        const blockStart = new Date(block.start_at).getTime();
        const blockEnd = new Date(block.end_at).getTime();
        // Block overlaps with this day's window
        return blockStart < window.windowEndUtcMs && blockEnd > window.windowStartUtcMs;
      })
      .map((block) => ({
        // Clip to window boundaries
        startMs: Math.max(new Date(block.start_at).getTime(), window.windowStartUtcMs),
        endMs: Math.min(new Date(block.end_at).getTime(), window.windowEndUtcMs),
      }))
      .sort((a, b) => a.startMs - b.startMs);

    // Find gaps between busy blocks
    let cursor = window.windowStartUtcMs;

    // If nowMs provided and it's within this window, start from now
    if (nowMs && nowMs > cursor && nowMs < window.windowEndUtcMs) {
      cursor = nowMs;
    }

    for (const busy of dayBusyBlocks) {
      if (busy.startMs > cursor) {
        // There's a gap before this busy block
        const gapMinutes = Math.floor((busy.startMs - cursor) / 60000);
        if (gapMinutes >= 10) {
          // Only include gaps of 10+ minutes
          focusBlocks.push({
            start_at: new Date(cursor).toISOString(),
            end_at: new Date(busy.startMs).toISOString(),
            minutes: gapMinutes,
            suitableFor: classifyFocusBlock(gapMinutes),
          });
        }
      }
      cursor = Math.max(cursor, busy.endMs);
    }

    // Check for gap after last busy block
    if (cursor < window.windowEndUtcMs) {
      const gapMinutes = Math.floor((window.windowEndUtcMs - cursor) / 60000);
      if (gapMinutes >= 10) {
        focusBlocks.push({
          start_at: new Date(cursor).toISOString(),
          end_at: new Date(window.windowEndUtcMs).toISOString(),
          minutes: gapMinutes,
          suitableFor: classifyFocusBlock(gapMinutes),
        });
      }
    }
  }

  return focusBlocks;
}

/**
 * Get the largest focus block available
 */
export function getLargestFocusBlock(focusBlocks: FocusBlock[]): FocusBlock | null {
  if (focusBlocks.length === 0) return null;
  return focusBlocks.reduce((largest, block) =>
    block.minutes > largest.minutes ? block : largest
  );
}

/**
 * Get total available focus minutes
 */
export function getTotalFocusMinutes(focusBlocks: FocusBlock[]): number {
  return focusBlocks.reduce((total, block) => total + block.minutes, 0);
}

/**
 * Format a focus block for display (e.g., "9:30-11:00 AM (90 min)")
 */
export function formatFocusBlock(block: FocusBlock, timezone = "America/New_York"): string {
  const startTime = new Date(block.start_at).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endTime = new Date(block.end_at).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${startTime}-${endTime} (${block.minutes} min)`;
}
