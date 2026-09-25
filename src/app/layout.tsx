import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Baseline",
  description: "Personal operations dashboard for Today, Backlog, Projects, and Applications.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the sidebar state server-side so the rail renders at its final width on
  // the first paint instead of expanding and then snapping shut.
  const cookieStore = await cookies();
  const collapsed = cookieStore.get("baseline_sidebar")?.value === "collapsed";

  let userEmail: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userEmail = user?.email ?? null;
  } catch {
    // Signed out, or auth is unreachable — the sidebar just shows no account.
  }

  return (
    <html lang="en">
      <body className="antialiased">
        <ToastProvider>
          <AppShell sidebar={<Sidebar userEmail={userEmail} defaultCollapsed={collapsed} />}>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
