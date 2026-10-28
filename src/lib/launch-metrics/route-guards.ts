/**
 * Who may call the launch-metrics routes.
 *
 * - The sync crons: `Authorization: Bearer <CRON_SECRET>` (Vercel cron), the
 *   same check as the calendar sync, compared in constant time.
 * - Everything else (Refresh now, Reddit and milestone forms): Brent's signed-in
 *   browser session only. Machine keys (legacy, actions, FamCal), bearer
 *   tokens and MCP don't reach these routes, and a write must come from the
 *   Baseline page itself (Origin = this host).
 */

import { secureCompare } from '@/lib/secure-compare';

export function hasCronAccess(authorization: string | null, cronSecret: string | undefined): boolean {
  const bearer = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : null;
  return Boolean(cronSecret && secureCompare(bearer, cronSecret));
}

/** A browser write: Origin must be present and name this host. */
export function isSameOriginWrite(origin: string | null, host: string | null): boolean {
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The page is Brent's: the session user must be MISSION_CONTROL_USER_ID (unset = nobody). */
export function isLaunchOwner(userId: string, configuredUserId: string | undefined): boolean {
  const owner = configuredUserId?.trim();
  return Boolean(owner) && secureCompare(userId, owner);
}
