// Client-safe (no node imports): used by validation on save/read and by the page before rendering a link.
import { BRIEF_EDITIONS } from "@/lib/briefs/types";

// Brief codes are EDITION-MMDD, plus the year when an earlier year holds the short code.
const BRIEF_HREF_PATTERN = new RegExp(`^/briefs/(${BRIEF_EDITIONS.map((edition) => edition.toUpperCase()).join("|")})-(\\d{4}|\\d{8})$`);

/**
 * A tile may link to another brief page, and nothing else: a same-app path
 * "/briefs/<CODE>" for a known edition. Anything else (other paths, other
 * hosts, protocol-relative or script URLs, query strings) is dropped.
 */
export function safeBriefHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw.startsWith("/briefs/")) return null;
  const path = `/briefs/${raw.slice("/briefs/".length).toUpperCase()}`;
  return BRIEF_HREF_PATTERN.test(path) ? path : null;
}
