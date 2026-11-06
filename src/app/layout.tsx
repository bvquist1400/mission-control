import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { PageViewAnalytics } from "@/components/analytics/PageViewAnalytics";
import { ToastProvider } from "@/components/ui/Toast";
import { DateCascadeProvider } from "@/components/tasks/DateCascadeProvider";
import { ProjectColorsProvider } from "@/components/project-colors/ProjectColorsProvider";
import { EMPTY_PROJECT_COLOR_CATALOG, loadProjectColorCatalog, type ProjectColorCatalog } from "@/lib/project-colors-queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMcpDeployment } from "@/lib/mcp/config";
import { getTodayBriefStatus } from "@/lib/briefs/service";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import { THEME_COOKIE, parseThemePreference, themeColorMeta, themeHtmlAttributes } from "@/lib/theme";
import { readPanelWidths } from "@/lib/task-panel";
import "./globals.css";

// IBM Plex (redesign S1): Sans for body text, Condensed for titles, tabs and
// buttons, Mono for dates, tags and numbers. The latin woff2 files are committed
// in src/fonts/plex (SIL OFL 1.1, OFL.txt there), byte-identical to the files
// the Google Fonts loader fetched for these weights, so a build never fetches
// Google: on 11/6 Vercel's build failed because Google answered with URLs
// Turbopack could not parse. Plex Sans is one variable file for 400/500/600,
// as Google served it. Same CSS variables, weights, display and Arial-based
// size-adjusted fallback as before.
const plexSans = localFont({
  src: [
    { path: "../fonts/plex/IBMPlexSans-Variable-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/plex/IBMPlexSans-Variable-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/plex/IBMPlexSans-Variable-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexCond = localFont({
  src: [
    { path: "../fonts/plex/IBMPlexSansCondensed-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/plex/IBMPlexSansCondensed-Medium-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/plex/IBMPlexSansCondensed-SemiBold-latin.woff2", weight: "600", style: "normal" },
    { path: "../fonts/plex/IBMPlexSansCondensed-Bold-latin.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-cond",
  display: "swap",
});
const plexMono = localFont({
  src: [
    { path: "../fonts/plex/IBMPlexMono-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/plex/IBMPlexMono-Medium-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/plex/IBMPlexMono-SemiBold-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Baseline",
  description: "Personal operations dashboard for Today, Tasks, Portfolio and Launch.",
  applicationName: "Baseline",
  appleWebApp: { capable: true, title: "Baseline", statusBarStyle: "black-translucent" },
};

async function readThemePreference() {
  const cookieStore = await cookies();
  return parseThemePreference(cookieStore.get(THEME_COOKIE)?.value);
}

/** The browser bar colour follows the same choice as the page (System: one per OS scheme). */
export async function generateViewport(): Promise<Viewport> {
  const preference = await readThemePreference();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: themeColorMeta(preference),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The light/dark choice is read here, on the server, and written onto <html>
  // so the first paint has the right colours (lib/theme.ts, globals.css).
  const theme = await readThemePreference();
  // The task panel's width per screen (redesign S3), read here so it renders at its final width.
  const cookieStore = await cookies();
  const panelWidths = readPanelWidths((name) => cookieStore.get(name)?.value);

  let userEmail: string | null = null;
  let todayBrief: TodayBriefStatus | null = null;
  let colorCatalog: ProjectColorCatalog = EMPTY_PROJECT_COLOR_CATALOG;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userEmail = user?.email ?? null;
    if (user) {
      // Project colours (S2) are read here too, so every square paints right on the first frame.
      [todayBrief, colorCatalog] = await Promise.all([
        getTodayBriefStatus(supabase, user.id).catch((error: unknown) => {
          console.error("[layout] today's brief status failed:", error);
          return null;
        }),
        loadProjectColorCatalog(supabase, user.id).catch((error: unknown) => {
          console.error("[layout] project colours failed:", error);
          return EMPTY_PROJECT_COLOR_CATALOG;
        }),
      ]);
    }
  } catch {
    // Signed out, or auth is unreachable — the top bar just shows no account.
  }

  return (
    <html
      lang="en"
      {...themeHtmlAttributes(theme)}
      className={`${plexSans.variable} ${plexCond.variable} ${plexMono.variable}`}
    >
      <body className="antialiased">
        <ToastProvider>
          <DateCascadeProvider>
            <ProjectColorsProvider initialCatalog={colorCatalog}>
              <AppShell topBar={<TopBar userEmail={userEmail} todayBrief={todayBrief} theme={theme} />} panelWidths={panelWidths}>
                {children}
              </AppShell>
            </ProjectColorsProvider>
          </DateCascadeProvider>
        </ToastProvider>
        {/* Page views: main deployment only. The MCP proxy never reports. */}
        {!isMcpDeployment() && <PageViewAnalytics />}
      </body>
    </html>
  );
}
