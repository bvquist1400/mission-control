import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { briefMono, briefSans } from "@/components/briefs/fonts";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { normalizeTaskScope } from "@/lib/personal-exclusion";
import { buildPortfolio } from "@/lib/portfolio";
import { loadPortfolioInput } from "@/lib/portfolio-queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import "@/components/briefs/brief-page.css";
import "@/components/portfolio/portfolio.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Portfolio · Baseline" };

interface PortfolioRouteProps {
  searchParams: Promise<{ scope?: string | string[] }>;
}

export default async function PortfolioRoute({ searchParams }: PortfolioRouteProps) {
  const { scope: rawScope } = await searchParams;
  const scope = normalizeTaskScope(Array.isArray(rawScope) ? rawScope[0] : rawScope, "personal");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(scope === "personal" ? "/portfolio" : `/portfolio?scope=${scope}`)}`);
  }

  const input = await loadPortfolioInput(supabase, user.id);
  const view = buildPortfolio(input, { scope });

  return (
    <div className={`brief-page pf ${briefSans.variable} ${briefMono.variable}`}>
      <PortfolioPage view={view} />
    </div>
  );
}
