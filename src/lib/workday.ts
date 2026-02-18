export interface WorkdayConfig {
  timezone: string;
  focusWindowStartHour: number;
  focusWindowEndHour: number;
}

export const DEFAULT_WORKDAY_CONFIG: WorkdayConfig = {
  timezone: 'America/New_York',
  focusWindowStartHour: 8,
  focusWindowEndHour: 16.5,
};

export function getFocusWindowMinutes(config: WorkdayConfig = DEFAULT_WORKDAY_CONFIG): number {
  return Math.max(0, (config.focusWindowEndHour - config.focusWindowStartHour) * 60);
}
