import type { MetadataRoute } from "next";
import { THEME_BAR_COLORS, THEME_PAPER_COLORS } from "@/lib/theme";

/**
 * Web-app manifest (redesign S1): "Add to Home Screen" gets the Baseline icon,
 * its own window without browser bars, and opens on Today. Icons are the mark
 * from the top bar on the olive bar colour (src/app/icon.svg is the source;
 * the PNGs are renders of it). The mark sits inside the maskable safe zone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Baseline",
    short_name: "Baseline",
    description: "Today, tasks, portfolio and launch numbers.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_PAPER_COLORS.light,
    theme_color: THEME_BAR_COLORS.light,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
