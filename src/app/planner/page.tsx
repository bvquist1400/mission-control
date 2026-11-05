import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/lib/legacy-redirects";

export default function LegacyPlannerPage() {
  redirect(legacyRedirectTarget("planner"));
}
