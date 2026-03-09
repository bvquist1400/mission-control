"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";

type Surface = "ChatGPT Actions" | "Claude MCP";

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
    title: "Start read-only",
    body: "Ask for recommendations first. Add `do not apply yet` when you want analysis without writes.",
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
    title: "Ask for IDs",
    body: "When you may approve follow-up actions, ask for task IDs in the recommendation so approval is one step later.",
  },
];

const PLAYBOOK_SECTIONS: PlaybookSection[] = [
  {
    title: "Cadence",
    description: "Best prompts for daily and weekly operating reviews.",
    playbooks: [
      {
        id: "daily-briefs",
        title: "Daily Briefs",
        summary: "Use the exact brief phrases, then ask for the recommended today list without applying it.",
        prompt: "morning brief. Then recommend a sync_today list with task IDs and one short reason each, but do not apply it yet.",
        alternates: [
          "midday brief. Call out what is done, what is still active, and whether I should replan.",
          "eod brief. Focus on rollover risk and tomorrow prep.",
        ],
        uses: ["get_calendar", "list_tasks", "list_sprints", "list_commitments", "sync_today"],
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/",
        hrefLabel: "Open Today",
        note: "Approving `sync_today` should be explicit. If you want only the recommendation, say `do not apply yet` every time.",
      },
      {
        id: "weekly-review",
        title: "Weekly Review",
        summary: "This is the fastest way to spot stalled work, pending decisions, and next-week actions.",
        prompt: "Run a weekly review for this week. Focus on stalled work, pending decisions, cold commitments, and end with the top 3 next-week actions.",
        alternates: [
          "Run a weekly review for 2026-03-09 and tell me what to escalate, park, or finish next week.",
          "Give me a weekly review focused only on shipped work and stalled work.",
        ],
        uses: ["get_weekly_review"],
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/weekly-review",
        hrefLabel: "Open Weekly Review",
        note: "If your custom GPT does not recognize weekly review yet, re-import the latest OpenAPI schema in the GPT builder.",
      },
    ],
  },
  {
    title: "Notes To Action",
    description: "Use these when you are pasting meeting notes, email threads, or rough action lists.",
    playbooks: [
      {
        id: "meeting-notes-review",
        title: "Review Notes Before Writing",
        summary: "Best default for pasted notes. It should suggest tasks, checklist items, stakeholder updates, and commitments without changing data yet.",
        prompt: "Review these meeting notes and suggest tasks, checklist items, stakeholder updates, and commitments, but do not apply anything yet:\n\n[paste notes here]",
        alternates: [
          "Summarize the exact Mission Control updates you recommend from these notes, including assumptions.",
          "Turn this into action items and commitment follow-ups, but wait for approval before writing.",
        ],
        uses: ["parse_notes", "create_task", "update_stakeholder", "create_commitment"],
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/backlog",
        hrefLabel: "Open Backlog",
      },
      {
        id: "meeting-notes-apply",
        title: "Apply Notes",
        summary: "Use only after you have reviewed the suggested changes and want the writes to happen.",
        prompt: "Apply these meeting notes to Mission Control. Create the tasks, update stakeholder context, and create any implied commitments:\n\n[paste notes here]",
        alternates: [
          "Apply the suggested updates from the notes we just reviewed.",
          "Create the tasks and commitment follow-ups from this thread, then summarize what changed.",
        ],
        uses: ["parse_notes", "create_task", "update_stakeholder", "create_commitment"],
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/stakeholders",
        hrefLabel: "Open Stakeholders",
        note: "If anything is ambiguous, the safer prompt is still the review-first version above.",
      },
    ],
  },
  {
    title: "Planning And Focus",
    description: "Prompts that work well with the planner and focus-directive system.",
    playbooks: [
      {
        id: "planner-recommendation",
        title: "Planner Recommendation",
        summary: "Ask for the plan plus a human-readable recommendation before anything is synced.",
        prompt: "Use the planner to recommend my today list. Include task IDs, explain why each task made the list, and wait for approval before sync_today.",
        alternates: [
          "Show me the planner recommendation for today and what should probably come off the list.",
          "Give me the now, next 3, and exceptions from the planner in plain English.",
        ],
        uses: ["get_plan", "sync_today"],
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/planner",
        hrefLabel: "Open Planner",
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
        surfaces: ["ChatGPT Actions", "Claude MCP"],
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
        surfaces: ["ChatGPT Actions", "Claude MCP"],
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
        surfaces: ["ChatGPT Actions", "Claude MCP"],
        href: "/stakeholders",
        hrefLabel: "Open Stakeholders",
      },
    ],
  },
  {
    title: "MCP-Only Retrieval",
    description: "Best when you know the topic but not the exact record yet. These workflows are available in Claude MCP, not the ChatGPT Actions schema.",
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
        surfaces: ["Claude MCP"],
        note: "ChatGPT Actions does not currently expose generic search/fetch. Use Claude MCP for this flow.",
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
    question: "Why did it recommend sync_today but not run it?",
    answer: "The planner workflow is designed to wait for explicit approval before calling `sync_today`.",
  },
  {
    question: "Why does ChatGPT sometimes miss a newly added tool?",
    answer: "The custom GPT keeps its own imported schema copy. Re-import the latest OpenAPI schema after tool changes.",
  },
  {
    question: "When should I use weekly review versus the planner?",
    answer: "Use weekly review for shipped work, drag, and next-week calls. Use the planner for the current day and the next ranked tasks.",
  },
];

function surfaceClass(surface: Surface): string {
  return surface === "ChatGPT Actions"
    ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
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
        description="Prompt patterns and workflow shortcuts for ChatGPT Actions and Claude MCP. Start read-only, use explicit scope and dates, and only say apply when you want writes."
      />

      <section className="rounded-card border border-amber-500/30 bg-amber-500/10 p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">Important</p>
        <p className="mt-2 text-sm text-amber-100">
          If your private ChatGPT GPT does not recognize a newly added workflow, re-import the latest OpenAPI schema in the GPT builder.
          The in-app page updates immediately, but the GPT action schema does not auto-refresh.
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
          <p className="mt-1 text-sm text-muted-foreground">The short answers to the things that usually feel inconsistent when you jump between the app and the GPT.</p>
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
