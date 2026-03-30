import type { Metadata } from "next";
import { Sidebar } from "@/components/layout/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Baseline",
  description: "Personal operations dashboard for Today, Backlog, Projects, and Applications.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="mx-auto flex min-h-screen w-full max-w-[2000px] gap-6 px-4 py-4 sm:px-6 lg:px-8">
          <Sidebar />
          <main className="min-h-[calc(100vh-2rem)] min-w-0 flex-1 rounded-2xl border border-stroke bg-panel p-5 pb-24 shadow-sm sm:p-6 sm:pb-24 xl:p-7 xl:pb-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
