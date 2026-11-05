"use client";

import { usePathname } from "next/navigation";
import { Analytics } from "@vercel/analytics/next";
import { beforeSendPageView, reportedRoute } from "@/lib/analytics/route-pattern";

// Client component because `beforeSend` is a function and cannot be passed from
// the server layout. Whether to render this at all is decided in the layout.
//
// `beforeSend` rewrites the reported url; `route` is Vercel's separate
// "page" field, which the package would otherwise compute from the raw path on
// URLs that match no route (a 404). Passing our pattern makes both a pattern.
// An empty route (a path we never report) sends no page view at all.
export function PageViewAnalytics() {
  // @vercel/analytics 2.0.1's Next wrapper omits `route` from its prop types but
  // spreads props after its own computed route at runtime, so ours wins. The
  // spread keeps TypeScript quiet; the test pins this wiring.
  const routeProps: Record<string, unknown> = { route: reportedRoute(usePathname()) };
  return <Analytics {...routeProps} beforeSend={beforeSendPageView} />;
}
