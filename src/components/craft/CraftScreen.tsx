import Link from "next/link";
import type { CraftView } from "@/lib/craft";
import { buttonClasses } from "@/components/ui/Button";
import "./craft.css";

export function CraftScreen({ view }: { view: CraftView }) {
  const part = view.active_part;
  const allFinished = !part && view.parts.length > 0;
  return (
    <main className="craft-screen">
      <header className="craft-header">
        <Link href={`/projects/${view.project.id}`} className={buttonClasses({ variant: "ghost", size: "icon" })} aria-label="Back to project">←</Link>
        <h1>Craft</h1>
        <span className="craft-readonly">Read only</span>
      </header>
      <div className="craft-columns">
        <section className="craft-front" aria-label="Current progress">
          <div className="craft-project"><p className="craft-eyebrow">{view.craft === "knit" ? "Knitting" : view.craft === "crochet" ? "Crochet" : "Craft"}</p><h2>{view.project.name}</h2>{view.gear && <p>{view.gear}</p>}</div>
          <div className="craft-part"><span className="craft-eyebrow">{allFinished ? "Project progress" : "Active part"}</span><h3>{part?.name ?? (allFinished ? "All parts finished" : "No parts yet")}</h3>{part?.stitch_count !== null && part?.stitch_count !== undefined && <p>{part.stitch_count} stitches</p>}</div>
          <div className="craft-timer"><p>Timer arrives in the next update</p></div>
          {part ? (
            <div className="craft-row">
              <p className="craft-eyebrow">{part.finished ? "Part complete" : `Current ${part.row_word}`}</p>
              {part.finished ? <p className="craft-finished">Finished</p> : <><div className="craft-number">{part.current_row}<span>of {part.total_rows}</span></div><p className="craft-row-label">{part.row_label}</p></>}
              {part.quarter > 0 && <p className="craft-quarter">{["", "¼", "½", "¾"][part.quarter]} of this {part.row_word} done</p>}
              <p className="craft-band-name">{view.current_segment?.name ?? (part.finished ? "All rows ticked" : "No band for this row")}</p>
              <p className="craft-meta">{part.done_rows} of {part.total_rows} {part.row_word}s ticked</p>
            </div>
          ) : <p className="craft-empty">{allFinished ? "Every part is finished. All rows are ticked." : "This project has no craft parts yet."}</p>}
          <section className="craft-today" aria-label="Today"><h3>Today</h3><p><strong>{view.today.rows}</strong> rows ticked <span>·</span> <strong>{view.today.minutes}</strong> min</p></section>
        </section>
        <aside className="craft-inside" aria-label="Project details">
          <section><h2>Parts</h2><ul className="craft-parts">{view.parts.map((entry) => <li key={entry.id} aria-current={entry.id === part?.id ? "true" : undefined}><strong>{entry.name}</strong><span>{entry.row_label}</span></li>)}</ul></section>
          <section><h2>Bands</h2>{view.segments.length ? <><div className="craft-strip" aria-label="Band progress">{view.segments.map((segment) => <span key={segment.id} data-state={segment.state} title={`${segment.name}: ${segment.from_row}–${segment.to_row}, ${segment.state}`} style={{ flexGrow: segment.to_row - segment.from_row + 1 }} />)}</div><ol className="craft-bands">{view.segments.map((segment) => <li key={segment.id} data-state={segment.state} aria-current={segment.state === "current" ? "step" : undefined}><span>{segment.state === "done" ? "✓ " : ""}{segment.name}</span><span>{part?.row_word}s {segment.from_row}–{segment.to_row}<small>{segment.state}</small></span></li>)}</ol></> : <p>No bands yet.</p>}
            {view.next_segment && <div className="craft-peek"><p className="craft-eyebrow">Coming up</p><h3>{view.next_segment.name}</h3><p>{part?.row_word}s {view.next_segment.from_row}–{view.next_segment.to_row}</p></div>}
          </section>
          <section><h2>Next rows</h2>{view.next_rows.length ? <ol className="craft-next">{view.next_rows.map((row) => <li key={row.id}>{row.text}</li>)}</ol> : <p>No unticked rows.</p>}</section>
          <section><h2>Recent sittings</h2>{view.recent_sittings.length ? <ol className="craft-sittings">{view.recent_sittings.map((sitting) => <li key={sitting.id}><div><time dateTime={sitting.date}>{sitting.date}</time><strong>{sitting.minutes} min</strong></div><p>{sitting.rows.length ? sitting.rows.map((row) => `${row.part_name}: ${row.row_word} ${row.row}`).join(" · ") : "No linked rows"}</p>{sitting.note && <p>{sitting.note}</p>}{sitting.excluded_from_stats && <p className="craft-meta">Excluded from pace stats</p>}</li>)}</ol> : <p>No sittings logged yet.</p>}</section>
        </aside>
      </div>
    </main>
  );
}
