import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BriefPage } from "@/components/briefs/BriefPage";
import { briefMono, briefSans } from "@/components/briefs/fonts";
import { BriefServiceError, getBrief } from "@/lib/briefs/service";
import { normalizeBriefCode } from "@/lib/briefs/keys";
import { getCanonicalAppUrl } from "@/lib/mcp/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { BriefView } from "@/lib/briefs/types";
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

  const wrapperClass = `brief-page ${briefSans.variable} ${briefMono.variable}`;

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

  return (
    <div className={wrapperClass}>
      <BriefPage view={view} />
    </div>
  );
}
