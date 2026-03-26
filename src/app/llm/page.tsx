"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";

type Surface = "MCP" | "Legacy Actions";

interface QuickTip {
  title: string;
  body: string;
}

interface PromptPlaybook {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  alternates: string[];
  uses: string[];
  surfaces: Surface[];
  href?: string;
  hrefLabel?: string;
  note?: string;
}

interface PlaybookSection {
  title: string;
  description: string;
  playbooks: PromptPlaybook[];
}

interface FaqItem {
  question: string;
  answer: string;
}

const QUICK_TIPS: QuickTip[] = [
  {
    title: "Start review-first",
    body: "Ask for recommendations first. Add `do not apply yet` when you want analysis without writes.",
  },
  {
    title: "Prefer MCP",
    body: "ChatGPT and Claude should both use Mission Control through MCP. Keep the older custom GPT Actions path only as a fallback.",
  },
  {
    title: "Use the inbox",
    body: "Open artifacts now surface in the morning brief and the Artifact Inbox. Accept or dismiss there instead of inventing tags or side notes.",
  },
  {
    title: "Use exact scope",
    body: "Name the application, project, stakeholder, or sprint so the LLM does not guess the target.",
  },
  {
    title: "Use exact dates",
    body: "Say `for 2026-03-13` instead of `this Friday` when timing matters.",
  },
  {
    title: "Preserve decisions",
    body: "If notes contain actual decisions, ask the LLM to preserve them explicitly instead of flattening them into generic note context.",
  },
];

const PLAYBOOK_SECTIONS: PlaybookSection[] = [
  {
    title: "Cadence",
    description: "Best prompts for the daily operating loop now that open review items and the artifact inbox are live.",
    playbooks: [
      {
        id: "daily-briefs",
        title: "Morning Brief + Open Review",
        summary: "Use the standard brief phrase, then explicitly ask for the open review items and what needs a decision first.",
        prompt: "morning brief. Then show the open review items, grouped by what needs a decision today, but do not apply anything yet.",
        alternates: [
          "midday brief. Call out what is done, what is still active, and which accepted artifacts are still awaiting action.",
          "eod brief. Focus on rollover risk, open artifacts, and tomorrow prep.",
        ],
        uses: ["get_calendar", "list_tasks", "list_sprints", "list_commitments", "get_briefing"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/",
        hrefLabel: "Open Today",
        note: "The morning brief is now the first place open artifacts surface. Use the inbox for the actual accept or dismiss decision.",
      },
      {
        id: "artifact-inbox-triage",
        title: "Artifact Inbox Triage",
        summary: "Best for decision passes when you want the LLM to help reason about open artifacts before you accept or dismiss them.",
        prompt: "Review the open artifacts in Mission Control. For each one, tell me whether I should accept or dismiss it, why, and what evidence matters most. Do not apply any status changes yet.",
        alternates: [
          "Walk the artifact inbox and rank the open items by urgency and confidence.",
          "Show me which accepted artifacts are still awaiting action and which open artifacts need a decision first.",
        ],
        uses: ["get_briefing", "list_tasks", "search", "fetch"],
        surfaces: ["MCP"],
        href: "/backlog?review=intelligence",
        hrefLabel: "Open Artifact Inbox",
        note: "The inbox already has the persisted summary, reason, evidence, and task linkage. The LLM should read that state, not recompute detector logic in the chat layer.",
      },
    ],
  },
  {
    title: "Notes To Action",
    description: "Use these when you are pasting meeting notes, email threads, or rough action lists into the notes-first workflow.",
    playbooks: [
      {
        id: "meeting-notes-review",
        title: "Review Notes Before Writing",
        summary: "Best default for pasted notes. It should suggest tasks, checklist items, stakeholder updates, and commitments without changing data yet.",
        prompt: "Review these meeting notes and suggest tasks, checklist items, stakeholder updates, commitments, and any explicit decisions that should be preserved, but do not apply anything yet:\n\n[paste notes here]",
        alternates: [
          "Summarize the exact Mission Control updates you recommend from these notes, including assumptions and any decisions that should be first-class.",
          "Turn this into action items and commitment follow-ups, but wait for approval before writing.",
        ],
        uses: ["parse_notes", "create_task", "update_stakeholder", "create_commitment", "create_note_decision"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/backlog",
        hrefLabel: "Open Backlog",
      },
      {
        id: "meeting-notes-apply",
        title: "Apply Notes",
        summary: "Use only after you have reviewed the suggested changes and want the writes to happen.",
        prompt: "Apply these meeting notes to Mission Control. Create the tasks, update stakeholder context, create any implied commitments, and preserve explicit decisions as decisions rather than burying them in prose:\n\n[paste notes here]",
        alternates: [
          "Apply the suggested updates from the notes we just reviewed.",
          "Create the tasks and commitment follow-ups from this thread, then summarize what changed.",
        ],
        uses: ["parse_notes", "create_task", "update_stakeholder", "create_commitment", "create_note_decision"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/stakeholders",
        hrefLabel: "Open Stakeholders",
        note: "If anything is ambiguous, the safer prompt is still the review-first version above.",
      },
    ],
  },
  {
    title: "Execution Control",
    description: "Prompts for steering active work now that detection, promotion, reminder comments, and the inbox are all live.",
    playbooks: [
      {
        id: "accepted-artifact-follow-through",
        title: "Accepted Artifact Follow-through",
        summary: "Use this when you want to inspect accepted artifacts that represent committed work still awaiting action.",
        prompt: "Show me the accepted artifacts that are still awaiting action. For each one, tell me what concrete next step would actually resolve it and whether the underlying task state supports that action.",
        alternates: [
          "Review accepted artifacts and tell me which ones are genuinely still active versus already resolved by newer task context.",
          "Walk the accepted queue and tell me what Brent has effectively committed to doing.",
        ],
        uses: ["search", "fetch", "list_tasks"],
        surfaces: ["MCP"],
        href: "/backlog?review=intelligence",
        hrefLabel: "Open Artifact Inbox",
      },
      {
        id: "focus-directive",
        title: "Focus Directive",
        summary: "Use a scope, a time window, and a reason so the planner has a concrete bias to apply.",
        prompt: "Set a strong focus directive on the Epic application until 3pm ET because I need deep work on the open implementation tasks.",
        alternates: [
          "Set a hard focus on stakeholder follow-up for the rest of today.",
          "Clear my current focus and set a nudge toward quick admin cleanup until noon ET.",
        ],
        uses: ["get_focus", "set_focus", "clear_focus"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/focus",
        hrefLabel: "Open Focus",
      },
    ],
  },
  {
    title: "Portfolio Reviews",
    description: "Prompts for project and stakeholder-level reviews, not just individual tasks.",
    playbooks: [
      {
        id: "project-review",
        title: "Project Review",
        summary: "Useful after the new progress bars, especially when you want the next actions behind the percentage.",
        prompt: "Review project [project name]. Summarize blockers, open tasks, completion progress, and the next 3 actions I should take.",
        alternates: [
          "Compare the most at-risk projects and tell me where delivery is slipping.",
          "Review this project and tell me what is actually blocked versus just not started.",
        ],
        uses: ["list_projects", "get_project", "list_tasks"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/projects",
        hrefLabel: "Open Projects",
      },
      {
        id: "stakeholder-follow-up",
        title: "Stakeholder Follow-up",
        summary: "Good for reviewing incoming obligations that are starting to age out.",
        prompt: "Show me cold incoming commitments, group them by stakeholder, and draft the follow-up tasks I should create.",
        alternates: [
          "Which stakeholders have open commitments that need follow-up this week?",
          "Review stakeholder commitments and tell me what I owe next.",
        ],
        uses: ["list_stakeholders", "list_commitments", "get_stakeholder", "create_task"],
        surfaces: ["MCP", "Legacy Actions"],
        href: "/stakeholders",
        hrefLabel: "Open Stakeholders",
      },
    ],
  },
  {
    title: "MCP-Native Retrieval",
    description: "Best when you know the topic but not the exact record yet. These workflows are native in MCP and are not exposed through the legacy Actions fallback.",
    playbooks: [
      {
        id: "search-fetch",
        title: "Search Then Fetch",
        summary: "Use this when you only remember a keyword, ticket ID, or theme and need the exact record before asking for an analysis.",
        prompt: "Search Mission Control for OAuth migration, fetch the best match, and summarize the latest open work and decisions still pending.",
        alternates: [
          "Search for weekly review follow-up, fetch the strongest match, and tell me what still needs action.",
          "Search for the stakeholder or project first if I only remember part of the name.",
        ],
        uses: ["search", "fetch"],
        surfaces: ["MCP"],
        note: "Legacy Actions does not expose generic search or fetch. Use MCP for this flow.",
      },
    ],
  },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Why did the GPT summarize changes instead of writing them?",
    answer: "That is the safer path. If you want the write to happen, say `apply these changes` after you review the recommendation.",
  },
  {
    question: "Why is something in the morning brief but not in the accepted inbox yet?",
    answer: "Open artifacts surface in the brief first. They only move to the accepted queue after you explicitly accept them in the Artifact Inbox.",
  },
  {
    question: "Should I use MCP or the legacy custom GPT?",
    answer: "Prefer MCP in both ChatGPT and Claude. Keep the legacy custom GPT only if you still need the older Actions-based fallback.",
  },
  {
    question: "Why would a legacy custom GPT miss a newly added tool?",
    answer: "The custom GPT keeps its own imported schema copy. Re-import the latest OpenAPI schema after tool changes.",
  },
  {
    question: "Why did a reminder show up as a system comment on a task?",
    answer: "That is the v1 reminder output. Accepted follow-up artifacts can be applied as durable `source='system'` task comments so the action is visible on the underlying task and auditable in the ledger.",
  },
  {
    question: "Why does the GPT need to preserve note decisions separately from notes?",
    answer: "Because decisions are stronger than generic note context. The intelligence layer reads both, but it should not flatten explicit decisions into undifferentiated evidence soup.",
  },
];

function surfaceClass(surface: Surface): string {
  return surface === "MCP"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
    : "border-sky-500/30 bg-sky-500/10 text-sky-200";
}

export default function LlmPage() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);

      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1600);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="AI Playbooks"
        description="Prompt patterns and workflow shortcuts for Mission Control over MCP, updated for the live intelligence layer, morning brief review items, artifact inbox, and notes-plus-decisions workflow."
      />

      <section className="rounded-card border border-amber-500/30 bg-amber-500/10 p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">Important</p>
        <p className="mt-2 text-sm text-amber-100">
          Mission Control now treats MCP as the default path for both ChatGPT and Claude. If you still use the older private custom GPT
          Actions setup, re-import the latest OpenAPI schema after workflow changes because that fallback schema does not auto-refresh. The
          current operating loop is brief first, inbox decision second, then reminder/apply paths through the existing artifact ledger.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {QUICK_TIPS.map((tip) => (
          <article key={tip.title} className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{tip.title}</p>
            <p className="mt-2 text-sm text-foreground">{tip.body}</p>
          </article>
        ))}
      </section>

      {PLAYBOOK_SECTIONS.map((section) => (
        <section key={section.title} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{section.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {section.playbooks.map((playbook) => (
              <article key={playbook.id} className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{playbook.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{playbook.summary}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {playbook.surfaces.map((surface) => (
                      <span
                        key={`${playbook.id}-${surface}`}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${surfaceClass(surface)}`}
                      >
                        {surface}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-stroke bg-panel-muted/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Best Prompt</p>
                    <button
                      type="button"
                      onClick={() => void handleCopy(playbook.id, playbook.prompt)}
                      className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
                    >
                      {copiedId === playbook.id ? "Copied" : "Copy Prompt"}
                    </button>
                  </div>
                  <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{playbook.prompt}</pre>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Alternates</p>
                    <div className="mt-2 space-y-2">
                      {playbook.alternates.map((alternate) => (
                        <p key={alternate} className="rounded-lg bg-panel-muted px-3 py-2 text-sm text-foreground">
                          {alternate}
                        </p>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What It Uses</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {playbook.uses.map((toolName) => (
                        <code key={toolName} className="rounded-md bg-panel-muted px-2 py-1 text-xs text-foreground">
                          {toolName}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>

                {playbook.note ? (
                  <p className="mt-4 rounded-lg border border-stroke/80 bg-panel-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {playbook.note}
                  </p>
                ) : null}

                {playbook.href && playbook.hrefLabel ? (
                  <div className="mt-4">
                    <Link
                      href={playbook.href}
                      className="inline-flex items-center rounded-lg border border-stroke bg-panel px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
                    >
                      {playbook.hrefLabel}
                    </Link>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">FAQ</h2>
          <p className="mt-1 text-sm text-muted-foreground">The short answers to the things that usually feel inconsistent when you jump between the app and your LLM client.</p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {FAQ_ITEMS.map((item) => (
            <article key={item.question} className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground">{item.question}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{item.answer}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
