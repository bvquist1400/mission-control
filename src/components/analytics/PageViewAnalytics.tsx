"use client";

import { Analytics } from "@vercel/analytics/next";
import { beforeSendPageView } from "@/lib/analytics/route-pattern";

// Client component because `beforeSend` is a function and cannot be passed from
// the server layout. Whether to render this at all is decided in the layout.
export function PageViewAnalytics() {
  return <Analytics beforeSend={beforeSendPageView} />;
}
