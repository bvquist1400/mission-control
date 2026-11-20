"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { CRAFT_NAME_MAX, CRAFT_SETUP_CHANGED, type CraftKind, type CraftSetupPlan, type PlannedPart } from "@/lib/craft/setup";
import { RESET_KEEPS, resetGoes, type CraftResetPreview } from "@/lib/craft/reset";
import "./craft.css";

const KINDS: { value: CraftKind; label: string }[] = [{ value: "knit", label: "Knitting" }, { value: "crochet", label: "Crochet" }, { value: "other", label: "Other" }];
const plural = (part: Pick<PlannedPart, "row_word">, n: number) => `${n} ${part.row_word}${n === 1 ? "" : "s"}`;
export const nameProblem = (name: string) => !name.trim() ? "Each part needs a name." : Array.from(name.trim()).length > CRAFT_NAME_MAX ? `Names can be at most ${CRAFT_NAME_MAX} characters.` : null;

/** The facts line under a part name: "Rounds · 31 · now round 15 · 36 stitches · 14 of 31 ticked". */
export function partFacts(part: PlannedPart) {
  return [
    part.row_word === "round" ? "Rounds" : "Rows",
    `${part.total_rows} in all`,
    part.current_row === null ? "all ticked" : `now ${part.row_word} ${part.current_row}`,
    part.stitch_count === null ? "stitches change" : `${part.stitch_count} stitches`,
    `${part.done_count} of ${plural(part, part.row_count)} ticked`,
  ].join(" · ");
}

const fmt = (n: number) => n.toLocaleString("en-US");
/** S4 (H): the stitch-count line under a part: "Stitch counts: fills 385 rows and 1 cast-on · 11,580 stitches in all". */
export function stitchFacts(part: PlannedPart): string {
  const { rows_filled, cast_ons_filled, total_stitches } = part.stitches;
  const filled = rows_filled + cast_ons_filled === 0 ? "nothing to fill"
    : `fills ${fmt(rows_filled)} ${part.row_word}${rows_filled === 1 ? "" : "s"}${cast_ons_filled ? ` and ${cast_ons_filled} cast-on${cast_ons_filled === 1 ? "" : "s"}` : ""}`;
  return `Stitch counts: ${filled} · ${fmt(total_stitches)} stitches in all`;
}
/** S4 (C): said once per part whose labels restart ("Row 1 (rep 2)"), so the numbers on the screen aren't a surprise. */
export const straightNote = (part: PlannedPart) =>
  `The ${part.row_word} numbers start again inside this part, so the screen counts its ${part.row_word}s straight through, 1 to ${fmt(part.total_rows)}. Each ${part.row_word} keeps its pattern text.`;

export type CreateResult = { ok: true } | { ok: false; changed: boolean; message: string };
/** POST the Create body; plain words back for any refusal. */
export async function sendCreate(projectId: string, body: { fingerprint: string; craft: CraftKind; names: string[] }, fetcher: typeof fetch = fetch): Promise<CreateResult> {
  try {
    const res = await fetcher(`/api/craft/setup/${projectId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const reply = await res.json().catch(() => ({})) as { error?: string; reason?: string };
    return { ok: false, changed: reply.reason === "changed", message: reply.error ?? "Create didn't work. Try again." };
  } catch {
    return { ok: false, changed: false, message: "Create didn't reach the server. Check the connection and try again." };
  }
}

/** S4 (B): POST the Reset body; plain words back for any refusal. */
export async function sendReset(projectId: string, body: { fingerprint: string; names: string[] }, fetcher: typeof fetch = fetch): Promise<CreateResult> {
  try {
    const res = await fetcher(`/api/craft/${projectId}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const reply = await res.json().catch(() => ({})) as { error?: string; reason?: string };
    return { ok: false, changed: reply.reason === "changed", message: reply.error ?? "Reset didn't work. Try again." };
  } catch {
    return { ok: false, changed: false, message: "Reset didn't reach the server. Check the connection and try again." };
  }
}

export function CraftSetupScreen({ projectId, plan, fingerprint, reset }: { projectId: string; plan: CraftSetupPlan; fingerprint: string; reset?: Omit<CraftResetPreview, "plan" | "fingerprint"> }) {
  const [names, setNames] = useState(() => plan.parts.map((part) => part.name));
  const [confirming, setConfirming] = useState(false);
  const [craft, setCraft] = useState<CraftKind>(plan.default_craft);
  const [state, setState] = useState<{ busy: boolean; error: string | null; changed: boolean }>({ busy: false, error: null, changed: false });
  const problems = names.map(nameProblem);
  const blocked = problems.some(Boolean);
  const swatches = plan.plain_items.filter((item) => item.swatch).length;

  async function create() {
    if (blocked || state.busy) return;
    setState({ busy: true, error: null, changed: false });
    const trimmed = names.map((name) => name.trim());
    const result = reset ? await sendReset(projectId, { fingerprint, names: trimmed }) : await sendCreate(projectId, { fingerprint, craft, names: trimmed });
    if (result.ok) { window.location.assign(`/craft/${projectId}`); return; }
    setConfirming(false);
    setState({ busy: false, error: result.message, changed: result.changed });
  }
  const skipped = plan.parts.flatMap((part) => part.stitches.skipped);

  return (
    <main className="craft-screen craft-setup">
      <header className="craft-header">
        <Link href={reset ? `/craft/${projectId}` : `/projects/${projectId}`} className={buttonClasses({ variant: "ghost", size: "icon" })} aria-label={reset ? "Back to craft screen" : "Back to project"}>←</Link>
        <h1>{reset ? "Reset craft screen" : "Set up craft screen"}</h1>
      </header>
      <div className="craft-setup-body">
        <div className="craft-project">
          <p className="craft-eyebrow">{reset ? "Preview · nothing changes until Reset" : "Preview · nothing is saved until Create"}</p>
          <h2>{plan.project.name}</h2>
        </div>
        {!plan.ok && (
          <section className="craft-setup-stop" role="alert" aria-labelledby="craft-setup-stop-title">
            <h3 id="craft-setup-stop-title">{reset ? "This project can\u2019t be reset" : "This project can\u2019t be set up yet"}</h3>
            <ul>{plan.stops.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {!reset && plan.stops.some((reason) => reason.startsWith("This project is already on the craft screen")) && (
              <Link href={`/craft/${projectId}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>Open craft screen</Link>
            )}
          </section>
        )}
        {reset && (
          <section className="craft-setup-section" aria-labelledby="craft-setup-now">
            <h2 id="craft-setup-now">On the craft screen now <span className="craft-setup-count">{reset.old_parts.length}</span></h2>
            <ul className="craft-setup-near">{reset.old_parts.map((part) => (
              <li key={part.id}><span>{part.name}</span><small>{part.row_count === 0 ? `empty (its ${part.row_word}s were deleted)` : `${part.row_count} ${part.row_word}${part.row_count === 1 ? "" : "s"}`}</small></li>
            ))}</ul>
            <h3>What moves to the new parts</h3>
            <ul className="craft-setup-carry">{reset.carry_lines.map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="craft-setup-hint">{RESET_KEEPS}</p>
          </section>
        )}
        {plan.parts.length > 0 && (
          <section className="craft-setup-section" aria-labelledby="craft-setup-parts">
            <h2 id="craft-setup-parts">Parts <span className="craft-setup-count">{plan.parts.length}</span></h2>
            <p className="craft-setup-hint">Each part keeps its own count. Rename a part here if you like.</p>
            <ol className="craft-setup-parts">
              {plan.parts.map((part, index) => (
                <li key={part.segments[0]?.task_id ?? index} data-active={index === plan.active_part_index ? "true" : undefined}>
                  <label className="craft-setup-name">
                    <span>Part {index + 1} name</span>
                    <input value={names[index]} maxLength={CRAFT_NAME_MAX + 20} disabled={!plan.ok}
                      aria-invalid={problems[index] ? true : undefined} aria-describedby={problems[index] ? `craft-setup-name-${index}` : undefined}
                      onChange={(event) => { const next = [...names]; next[index] = event.target.value; setNames(next); }} />
                  </label>
                  {problems[index] && <p className="craft-setup-error" id={`craft-setup-name-${index}`}>{problems[index]}</p>}
                  <p className="craft-setup-facts">{partFacts(part)}</p>
                  <p className="craft-setup-facts">{stitchFacts(part)}</p>
                  {part.numbering === "straight" && <p className="craft-setup-gap">{straightNote(part)}</p>}
                  {part.stitches.skipped.map((skip) => <p key={skip.task_id} className="craft-setup-gap">Stitch counts not filled on “{skip.task_title}”: {skip.reason}</p>)}
                  {index === plan.active_part_index && <p className="craft-setup-active">The craft screen opens on this part</p>}
                  {part.gap_notes.map((note) => <p key={note} className="craft-setup-gap">{note}</p>)}
                  <ol className="craft-setup-segs" aria-label={`Tasks in ${names[index] || part.name}`}>
                    {part.segments.map((segment) => (
                      <li key={segment.task_id}><span>{segment.name}</span><span>{part.row_word}s {segment.from_row}–{segment.to_row}</span></li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="craft-setup-section" aria-labelledby="craft-setup-plain">
          <h2 id="craft-setup-plain">Plain steps <span className="craft-setup-count">{plan.plain_items.length}</span></h2>
          <p className="craft-setup-hint">These checklist items stay as they are: not counted as {plan.parts[0]?.row_word ?? "row"}s{swatches ? `; ${swatches} on swatch tasks are marked [swatch]` : ""}.</p>
          {plan.plain_items.length > 0 && (
            <details className="craft-setup-details">
              <summary>Show the {plan.plain_items.length} plain steps</summary>
              <ul>{plan.plain_items.map((item) => (
                <li key={item.id}><span>{item.swatch && <strong>[swatch] </strong>}{item.text}</span><small>{item.task_title}</small></li>
              ))}</ul>
            </details>
          )}
        </section>
        {plan.near_misses.length > 0 && (
          <section className="craft-setup-section" aria-labelledby="craft-setup-near">
            <h2 id="craft-setup-near">Not counted as rounds/rows <span className="craft-setup-count">{plan.near_misses.length}</span></h2>
            <p className="craft-setup-hint">These look numbered but don&rsquo;t start exactly like &ldquo;Rnd 12&rdquo;, &ldquo;Round 12&rdquo; or &ldquo;Row 12&rdquo; (capital first letter, a space, then the number). Fix them in the app before Create if they should count.</p>
            <ul className="craft-setup-near">{plan.near_misses.map((item) => (
              <li key={item.id}><span>{item.text}</span><small>{item.task_title}</small></li>
            ))}</ul>
          </section>
        )}
        {plan.ok && (
          <section className="craft-setup-section" aria-labelledby="craft-setup-create">
            <h2 id="craft-setup-create">{reset ? "Reset" : "Create"}</h2>
            {skipped.length > 0 && <p className="craft-setup-hint">{skipped.length === 1 ? "One task keeps" : `${skipped.length} tasks keep`} its rows without stitch counts (listed under its part); the rest get theirs.</p>}
            {!reset && <fieldset className="craft-setup-kind">
              <legend>Craft</legend>
              {KINDS.map((kind) => (
                <label key={kind.value}><input type="radio" name="craft-kind" value={kind.value} checked={craft === kind.value} onChange={() => setCraft(kind.value)} />{kind.label}</label>
              ))}
            </fieldset>}
            {state.error && (
              <div className="craft-setup-stop" role="alert">
                <p>{state.changed ? CRAFT_SETUP_CHANGED : state.error}</p>
                {state.changed && <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Open the preview again</Button>}
              </div>
            )}
            {reset ? (
              <Button variant="danger" size="md" onClick={() => setConfirming(true)} disabled={blocked || state.busy || state.changed}>
                {`Reset to ${plan.parts.length} part${plan.parts.length === 1 ? "" : "s"}…`}
              </Button>
            ) : (
              <Button variant="primary" size="md" onClick={create} disabled={blocked || state.busy || state.changed} aria-busy={state.busy || undefined}>
                {state.busy ? "Creating…" : `Create ${plan.parts.length} part${plan.parts.length === 1 ? "" : "s"} on the craft screen`}
              </Button>
            )}
            <p className="craft-setup-hint">{reset
              ? "Ticks stay on the rows. Empty stitch counts are filled as shown; counts already there are never changed."
              : "Ticks and sittings are not changed; empty stitch counts are filled as shown. You can remove it from the craft screen later."}</p>
          </section>
        )}
        {reset && plan.ok && (
          <Modal open={confirming} onClose={() => { if (!state.busy) setConfirming(false); }} title="Reset craft screen?">
            <div className="craft-remove">
              <p><strong>{plan.project.name}</strong></p>
              <p>{resetGoes(reset.old_parts.length, plan.parts.length)} <strong>{RESET_KEEPS}</strong></p>
              <ul>{reset.carry_lines.map((line) => <li key={line}>{line}</li>)}</ul>
              <div className="craft-remove-actions">
                <Button variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={state.busy}>Cancel</Button>
                <Button variant="danger" size="md" onClick={create} disabled={state.busy} aria-busy={state.busy || undefined}>{state.busy ? "Resetting…" : "Reset"}</Button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </main>
  );
}
