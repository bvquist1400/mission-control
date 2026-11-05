import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BriefPage } from "@/components/briefs/BriefPage";
import { BriefServiceError, getBrief, getBriefStatus } from "@/lib/briefs/service";
import { lateDigestBannerText } from "@/lib/briefs/refresh-view";
import { normalizeBriefCode } from "@/lib/briefs/keys";
import { getCanonicalAppUrl } from "@/lib/mcp/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { BRIEF_EDITIONS, type BriefEdition, type BriefView } from "@/lib/briefs/types";
import "@/components/briefs/brief-page.css";

export const dynamic = "force-dynamic";

interface BriefRouteProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({ params }: BriefRouteProps): Promise<Metadata> {
  const { code } = await params;
  return { title: `${normalizeBriefCode(decodeURIComponent(code))} · Baseline` };
}

export default async function BriefRoute({ params }: BriefRouteProps) {
  const { code: rawCode } = await params;
  const code = normalizeBriefCode(decodeURIComponent(rawCode));

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/briefs/${code}`)}`);
  }

  const wrapperClass = "brief-page";

  let view: BriefView | null = null;
  try {
    view = await getBrief(supabase, user.id, code, { appUrl: getCanonicalAppUrl() });
  } catch (error) {
    if (!(error instanceof BriefServiceError && error.status === 404)) throw error;
  }

  if (!view) {
    return (
      <div className={wrapperClass}>
        <div className="page">
          <div className="missing">
            <h1>No brief {code}</h1>
            <p className="tile-p">It may not have been saved yet, or the code is from another account.</p>
            <p className="tile-p">
              <Link href="/">Back to Baseline</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const lateDigestBanner = await readLateDigestBanner(supabase, user.id, view);

  return (
    <div className={wrapperClass}>
      <BriefPage view={view} lateDigestBanner={lateDigestBanner} />
    </div>
  );
}

/**
 * The late-digest banner: a work digest note this brief should cover is filed
 * but not in it (brief_status's rule). Read at render, so no hook on note
 * creation is needed. A failed read only means no banner.
 */
async function readLateDigestBanner(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  view: BriefView
): Promise<string | null> {
  const { brief } = view;
  if (!(BRIEF_EDITIONS as readonly string[]).includes(brief.edition)) return null;
  const edition = brief.edition as BriefEdition;
  try {
    const status = await getBriefStatus(supabase, userId, edition, brief.brief_date);
    return lateDigestBannerText({
      edition,
      briefDate: brief.brief_date,
      builtAt: brief.created_at,
      notes: status.digest_notes.filter((note) => note.needs_refresh).map((note) => ({ edition: note.edition, filed_at: note.filed_at })),
      now: new Date(),
    });
  } catch (error) {
    console.warn("[briefs] late digest check failed", { code: (error as { code?: unknown } | null)?.code ?? "unknown" });
    return null;
  }
}
