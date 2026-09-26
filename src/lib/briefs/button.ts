// The app-shell "brief ready" button. Pure, so its states are testable without React.

export interface TodayBriefStatus {
  code: string;
  brief_date: string;
  open: number;
  total: number;
}

export interface BriefButtonView {
  href: string;
  label: string;
  /** "open" is lit (decisions waiting); "done" is quiet but stays as a way back to the page. */
  tone: "open" | "done";
  title: string;
}

/** No brief today → nothing. Open items → lit. Everything decided → a quiet "done". */
export function briefButtonView(status: TodayBriefStatus | null): BriefButtonView | null {
  if (!status) return null;
  const href = `/briefs/${encodeURIComponent(status.code)}`;
  if (status.open > 0) {
    return {
      href,
      label: `${status.code} · ${status.open} to decide`,
      tone: "open",
      title: `Today's brief has ${status.open} item${status.open === 1 ? "" : "s"} to decide`,
    };
  }
  return { href, label: `${status.code} · done`, tone: "done", title: "Everything in today's brief is decided" };
}
