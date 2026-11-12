"use client";
import { useEffect, useState } from "react";

type Sentinel = { released: boolean; release: () => Promise<void>; addEventListener: (type: "release", fn: () => void) => void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<Sentinel> } };

/**
 * Screen Wake Lock while `active` (the timer runs). Safari 16.4+, and in a home-screen web app only from iOS 18.4
 * (plan risk 4), so `held` is the truth: the screen shows "screen on" only while the lock is held, else the
 * Auto-Lock tip. The lock is dropped by the browser when the page hides or the Duo folds, so it is asked for again
 * on visibilitychange and on resize.
 */
export function useWakeLock(active: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;
    let sentinel: Sentinel | null = null;
    let stopped = false;
    const request = async () => {
      if (stopped || document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const next = await nav.wakeLock!.request("screen");
        if (stopped) { await next.release(); return; }
        sentinel = next;
        setHeld(true);
        next.addEventListener("release", () => { if (sentinel === next) setHeld(false); });
      } catch {
        setHeld(false);
      }
    };
    void request();
    document.addEventListener("visibilitychange", request);
    window.addEventListener("resize", request);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", request);
      window.removeEventListener("resize", request);
      const current = sentinel;
      sentinel = null;
      setHeld(false);
      void current?.release().catch(() => {});
    };
  }, [active]);
  return active && held;
}
