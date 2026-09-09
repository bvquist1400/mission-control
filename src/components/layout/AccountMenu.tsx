"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

/**
 * Account block pinned to the bottom of the sidebar. Until this existed there
 * was no way to sign out of the app at all.
 */
export function AccountMenu({ email, collapsed }: { email: string | null; collapsed: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);

  const initial = (email?.trim()?.[0] ?? "?").toUpperCase();

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      router.push("/login");
      router.refresh();
    } catch (error) {
      setSigningOut(false);
      toast({
        tone: "danger",
        message: error instanceof Error ? error.message : "Couldn't sign out.",
      });
    }
  }

  if (collapsed) {
    return (
      <div className="mt-auto flex flex-col items-center gap-2 border-t border-stroke pt-4">
        <span
          title={email ?? "Signed in"}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-stroke bg-panel-muted text-xs font-semibold text-foreground"
        >
          {initial}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleSignOut}
          disabled={signingOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <svg aria-hidden="true" className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
          </svg>
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-auto border-t border-stroke pt-4">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stroke bg-panel-muted text-xs font-semibold text-foreground"
        >
          {initial}
        </span>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={email ?? undefined}>
          {email ?? "Signed in"}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2 w-full"
        onClick={handleSignOut}
        disabled={signingOut}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
