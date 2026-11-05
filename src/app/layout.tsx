import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { PageViewAnalytics } from "@/components/analytics/PageViewAnalytics";
import { ToastProvider } from "@/components/ui/Toast";
import { DateCascadeProvider } from "@/components/tasks/DateCascadeProvider";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMcpDeployment } from "@/lib/mcp/config";
import { getTodayBriefStatus } from "@/lib/briefs/service";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import { THEME_COOKIE, parseThemePreference, themeColorMeta, themeHtmlAttributes } from "@/lib/theme";
import "./globals.css";

// IBM Plex (redesign S1): Sans for body text, Condensed for titles, tabs and
// buttons, Mono for dates, tags and numbers. Self-hosted by next/font at build.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexCond = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-cond",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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

  let userEmail: string | null = null;
  let todayBrief: TodayBriefStatus | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userEmail = user?.email ?? null;
    if (user) {
      todayBrief = await getTodayBriefStatus(supabase, user.id).catch((error: unknown) => {
        console.error("[layout] today's brief status failed:", error);
        return null;
      });
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
            <AppShell topBar={<TopBar userEmail={userEmail} todayBrief={todayBrief} theme={theme} />}>{children}</AppShell>
          </DateCascadeProvider>
        </ToastProvider>
        {/* Page views: main deployment only. The MCP proxy never reports. */}
        {!isMcpDeployment() && <PageViewAnalytics />}
      </body>
    </html>
  );
}
