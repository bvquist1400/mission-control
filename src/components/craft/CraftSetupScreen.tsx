"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { CRAFT_NAME_MAX, CRAFT_SETUP_CHANGED, type CraftKind, type CraftSetupPlan, type PlannedPart } from "@/lib/craft/setup";
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

export function CraftSetupScreen({ projectId, plan, fingerprint }: { projectId: string; plan: CraftSetupPlan; fingerprint: string }) {
  const [names, setNames] = useState(() => plan.parts.map((part) => part.name));
  const [craft, setCraft] = useState<CraftKind>(plan.default_craft);
  const [state, setState] = useState<{ busy: boolean; error: string | null; changed: boolean }>({ busy: false, error: null, changed: false });
  const problems = names.map(nameProblem);
  const blocked = problems.some(Boolean);
  const swatches = plan.plain_items.filter((item) => item.swatch).length;

  async function create() {
    if (blocked || state.busy) return;
    setState({ busy: true, error: null, changed: false });
    const result = await sendCreate(projectId, { fingerprint, craft, names: names.map((name) => name.trim()) });
    if (result.ok) { window.location.assign(`/craft/${projectId}`); return; }
    setState({ busy: false, error: result.message, changed: result.changed });
  }

  return (
    <main className="craft-screen craft-setup">
      <header className="craft-header">
        <Link href={`/projects/${projectId}`} className={buttonClasses({ variant: "ghost", size: "icon" })} aria-label="Back to project">←</Link>
        <h1>Set up craft screen</h1>
      </header>
      <div className="craft-setup-body">
        <div className="craft-project">
          <p className="craft-eyebrow">Preview · nothing is saved until Create</p>
          <h2>{plan.project.name}</h2>
        </div>
        {!plan.ok && (
          <section className="craft-setup-stop" role="alert" aria-labelledby="craft-setup-stop-title">
            <h3 id="craft-setup-stop-title">This project can&rsquo;t be set up yet</h3>
            <ul>{plan.stops.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {plan.stops.some((reason) => reason.startsWith("This project is already on the craft screen")) && (
              <Link href={`/craft/${projectId}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>Open craft screen</Link>
            )}
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
        {plan.ok && (
          <section className="craft-setup-section" aria-labelledby="craft-setup-create">
            <h2 id="craft-setup-create">Create</h2>
            <fieldset className="craft-setup-kind">
              <legend>Craft</legend>
              {KINDS.map((kind) => (
                <label key={kind.value}><input type="radio" name="craft-kind" value={kind.value} checked={craft === kind.value} onChange={() => setCraft(kind.value)} />{kind.label}</label>
              ))}
            </fieldset>
            {state.error && (
              <div className="craft-setup-stop" role="alert">
                <p>{state.changed ? CRAFT_SETUP_CHANGED : state.error}</p>
                {state.changed && <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Open the preview again</Button>}
              </div>
            )}
            <Button variant="primary" size="md" onClick={create} disabled={blocked || state.busy || state.changed} aria-busy={state.busy || undefined}>
              {state.busy ? "Creating…" : `Create ${plan.parts.length} part${plan.parts.length === 1 ? "" : "s"} on the craft screen`}
            </Button>
            <p className="craft-setup-hint">Ticks, stitch counts and sittings are not changed. You can remove it from the craft screen later.</p>
          </section>
        )}
      </div>
    </main>
  );
}
