/**
 * Time-of-day detection for Daily Briefing modes
 */

export type BriefingMode = "morning" | "midday" | "eod";

const ET_TIMEZONE = "America/New_York";

/**
 * Get current time in Eastern Time
 */
export function getETTime(now: Date = new Date()): Date {
  const etString = now.toLocaleString("en-US", { timeZone: ET_TIMEZONE });
  return new Date(etString);
}

/**
 * Get current hour in Eastern Time (0-23)
 */
export function getETHour(now: Date = new Date()): number {
  return getETTime(now).getHours();
}

/**
 * Detect the appropriate briefing mode based on current time
 * - Morning: before noon (< 12)
 * - Midday: noon to 3pm (12-14)
 * - EOD: 3pm and after (>= 15)
 */
export function detectBriefingMode(now: Date = new Date()): BriefingMode {
  const hour = getETHour(now);

  if (hour < 12) {
    return "morning";
  } else if (hour < 15) {
    return "midday";
  } else {
    return "eod";
  }
}

/**
 * Get a human-readable label for the briefing mode
 */
export function getBriefingModeLabel(mode: BriefingMode): string {
  switch (mode) {
    case "morning":
      return "Morning";
    case "midday":
      return "Midday";
    case "eod":
      return "EOD";
  }
}

/**
 * Format current ET time for display (e.g., "9:30 AM ET")
 */
export function formatETTime(now: Date = new Date()): string {
  return now.toLocaleTimeString("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

/**
 * Get today's date string in ET (YYYY-MM-DD)
 */
export function getTodayET(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: ET_TIMEZONE });
}

/**
 * Get tomorrow's date string in ET (YYYY-MM-DD)
 */
export function getTomorrowET(now: Date = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-CA", { timeZone: ET_TIMEZONE });
}
