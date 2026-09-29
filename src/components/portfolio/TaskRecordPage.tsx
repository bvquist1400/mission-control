import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { TaskEditButton } from "@/components/portfolio/PortfolioTasks";
import { TaskPageCommentBox, TaskPageHandBack } from "@/components/portfolio/TaskPageActions";
import { formatShortDate } from "@/lib/portfolio";
import type { TaskPageComment, TaskPageView } from "@/lib/task-page";
import type { TaskStatus } from "@/types/database";

/** Pill tones; prefixed because brief-page.css already styles `.prog` (the progress bar). */
const STATUS_TONE: Record<TaskStatus, string> = {
  Backlog: "tone-quiet",
  Planned: "tone-quiet",
  "In Progress": "tone-prog",
  "Blocked/Waiting": "tone-wait",
  Parked: "tone-quiet",
  Missed: "tone-late",
  Done: "tone-done",
};

function Chip({ who, label, initial }: { who: "brent" | "agent" | null; label: string; initial?: string }) {
  return (
    <span className={`pf-own ${who === "brent" ? "you" : "agent"}`}>
      <i aria-hidden="true">{who === "brent" ? "B" : (initial ?? label).charAt(0).toUpperCase()}</i>
      {label}
    </span>
  );
}

function CommentCard({ comment }: { comment: TaskPageComment }) {
  return (
    <li className="pf-cmt">
      <div className="pf-cmt-m">
        {comment.label ? <Chip who={comment.who} label={comment.label} /> : <span />}
        <span className="mono">{comment.when}</span>
      </div>
      <p className="pf-cmt-g">{comment.gist || <span className="pf-muted">(empty comment)</span>}</p>
      {comment.truncated ? (
        <details className="pf-cmt-more">
          <summary>
            <span className="pf-when-closed">Show the full comment</span>
            <span className="pf-when-open">Hide the full comment</span>
          </summary>
          <Markdown source={comment.body} className="pf-cmt-full" />
        </details>
      ) : null}
    </li>
  );
}

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className} aria-label={title}>
      <div className="pf-col-h">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * The task page (mockup section 4): where it stands at the top with the owner
 * and status, Brent's answer box when it's his, then the checklist beside the
 * activity (stacked on a phone), one-line comment gists that unfold, and the
 * description as formatted text at a readable width.
 */
export function TaskRecordPage({ view, details }: { view: TaskPageView; details: ReactNode }) {
  const mine = view.owner === "brent";
  const { decision } = view;
  const commentCount = view.recentComments.length + view.olderComments.length;
  return (
    <>
      <header className="tile pf-task-head">
        <div className="eyebrow">
          <span className="code">TASK</span>
          {view.context.length ? <span>{view.context.join(" · ")}</span> : null}
        </div>
        <h1>{view.title}</h1>
        <div className="pf-meta">
          <Chip who={view.owner} label={mine ? "Owner: You" : `Owner: ${view.ownerLabel}`} initial={view.ownerLabel} />
          <span className={`pf-pill ${STATUS_TONE[view.status] ?? "tone-quiet"}`}>{view.status}</span>
          {view.blocked && view.status !== "Blocked/Waiting" ? <span className="pf-pill tone-wait">Blocked</span> : null}
          {view.due ? (
            <span className={`pf-pill ${view.overdue ? "tone-late" : "tone-quiet"}`}>
              {view.overdue ? "Was due" : "Due"} {formatShortDate(view.due)}
            </span>
          ) : null}
          {decision ? <span className="pf-pill tone-quiet">Decision</span> : null}
        </div>

        <div className="pf-stand-box">
          <span className="mono">WHERE THIS STANDS</span>
          <span>{view.stand}</span>
          {view.blocked && view.waits.length > 0 ? <span className="pf-stand-waits">{view.waits.join(" · ")}</span> : null}
        </div>

        <div className="pf-task-actions">
          {mine ? <TaskPageHandBack taskId={view.id} decision={decision} startOpen /> : null}
          <div className="pf-handoff">
            <TaskEditButton taskId={view.id} />
            {mine ? null : (
              <span>
                {view.ownerLabel === "Agent" ? "An agent has it." : `${view.ownerLabel} has it.`} It comes to you when there&apos;s
                something for you to do.
              </span>
            )}
          </div>
        </div>
      </header>

      {view.description ? (
        <details className="tile pf-task-desc" open={!view.descriptionFolded}>
          <summary>Description</summary>
          <Markdown source={view.description} />
        </details>
      ) : null}

      <div className="pf-two">
        <Section
          title="Checklist"
          className="tile pf-task-col"
          aside={view.checklist.length ? <span className="mono pf-count">{view.checklistDone} / {view.checklist.length}</span> : null}
        >
          {view.checklist.length ? (
            <ul className="pf-check">
              {view.checklist.map((item) => (
                <li key={item.id} className={item.is_done ? "done" : undefined}>
                  <span className={`pf-box${item.is_done ? " y" : ""}`} aria-hidden="true">
                    {item.is_done ? "✓" : ""}
                  </span>
                  <span>
                    <span className="pf-sr">{item.is_done ? "Done: " : "To do: "}</span>
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tile-p">No checklist. Add items with Edit.</p>
          )}
        </Section>

        <Section
          title="Activity"
          className="tile pf-task-col"
          aside={commentCount ? <span className="mono pf-count">{commentCount}</span> : null}
        >
          <TaskPageCommentBox taskId={view.id} />
          {commentCount ? (
            <ul className="pf-cmts">
              {view.recentComments.map((comment) => (
                <CommentCard key={comment.id} comment={comment} />
              ))}
            </ul>
          ) : (
            <p className="tile-p">No comments yet.</p>
          )}
          {view.olderComments.length ? (
            <details className="pf-older">
              <summary>
                Show {view.olderComments.length} older {view.olderComments.length === 1 ? "comment" : "comments"}
              </summary>
              <ul className="pf-cmts">
                {view.olderComments.map((comment) => (
                  <CommentCard key={comment.id} comment={comment} />
                ))}
              </ul>
            </details>
          ) : null}
        </Section>
      </div>

      {details}
    </>
  );
}
