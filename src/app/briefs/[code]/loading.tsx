import Link from "next/link";
import { briefMono, briefSans } from "@/components/briefs/fonts";
import "@/components/briefs/brief-page.css";

/**
 * Shown the moment a brief is opened, while the server reads it (speed check
 * fix 2). Same frame as the real page (top bar + tile grid), no data.
 */
export default function BriefLoading() {
  return (
    <div className={`brief-page ${briefSans.variable} ${briefMono.variable}`}>
      <div className="page" role="status" aria-live="polite" aria-busy="true">
        <div className="topbar">
          <Link href="/">← Baseline</Link>
          <span className="skel-sr">Loading the brief…</span>
        </div>

        <div className="bento" aria-hidden="true">
          <div className="tile span-4 skel-tile">
            <div className="skel skel-line skel-w-25" />
            <div className="skel skel-line skel-lg skel-w-70" />
            <div className="skel skel-line skel-w-50" />
          </div>
          <div className="tile span-2 skel-tile">
            <div className="skel skel-line skel-w-50" />
            <div className="skel skel-line skel-w-90" />
            <div className="skel skel-line skel-w-70" />
          </div>
          <div className="tile span-6 skel-tile">
            <div className="skel skel-line skel-w-25" />
            <div className="skel skel-line skel-w-90" />
            <div className="skel skel-line skel-w-70" />
            <div className="skel skel-line skel-w-50" />
          </div>
        </div>

        <div className="bento" aria-hidden="true">
          <div className="tile span-3 skel-tile">
            <div className="skel skel-line skel-w-70" />
            <div className="skel skel-line skel-w-50" />
          </div>
          <div className="tile span-3 skel-tile">
            <div className="skel skel-line skel-w-70" />
            <div className="skel skel-line skel-w-50" />
          </div>
        </div>
      </div>
    </div>
  );
}
