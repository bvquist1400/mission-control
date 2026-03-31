# Notes Review / Context Distillation Concept

## Why this exists

Mission Control now has linked notes across implementation, meeting, and task context. That creates a real lifecycle problem:

- notes are useful when fresh
- notes rot when nobody curates them
- stale note piles eventually become untrusted

The goal of this concept is to keep notes useful over time **without** letting automation silently rewrite reality.

## Core principle

**Approval first.**

Generated note synthesis should produce:
- review artifacts
- consolidation suggestions
- archive suggestions
- status update suggestions

It should **not** silently:
- archive notes
- merge notes
- create decisions
- mutate project/application state
- rewrite status summaries

## Three-layer model

### 1. Raw notes
User-authored, linked, messy, live context.

Examples:
- implementation notes
- meeting notes
- task notes
- prep notes
- working notes

### 2. Review artifacts
Generated weekly/monthly artifacts that summarize, consolidate, and flag patterns.

Examples:
- notes that look stale
- notes that overlap and could be merged
- notes that contain likely decisions but have not been structured as decisions
- repeated blockers/themes across applications or projects
- suggested summary updates

### 3. Approved state changes
Only after explicit application:
- archive note
- update application/project summary
- promote note into a durable decision or memory object
- possibly merge/retire redundant notes later

## Recommended rollout

### V1: Weekly Notes Review
A weekly cron/job reads recent notes and writes a review artifact only.

Suggested responsibilities:
- collect notes changed in the last 7 days
- bucket by implementation / project / meeting / task
- identify stale or overlapping notes
- identify unresolved threads
- identify likely follow-up debt
- suggest concise grouped summaries

Output should be proposal-only.

### V1.5: Monthly Context Distillation
A monthly job reads weekly note-review artifacts and produces higher-level suggestions.

Suggested responsibilities:
- identify recurring blockers/themes
- suggest project/application summary updates
- identify notes worth promoting into durable project/application memory
- identify stale context ready for archive review

Still proposal-only.

### Later (optional)
Human-approved actions such as:
- one-click archive suggested stale notes
- one-click apply suggested application/project summary updates
- one-click promote note context into durable memory/decision records

## What should not happen early

Do **not** start with:
- cron directly updating projects/applications from notes
- silent archive/merge behavior
- silent decision creation
- automatic note-to-status mutation without review

That is the fastest path to haunted dashboards and low trust.

## Relation to Mission Control's intelligence layer

This concept is a future extension of the canonical work-intelligence/review ladder, not part of the current notes UI work.

The healthy sequence is:
1. notes become real and useful in the product
2. review artifacts summarize them safely
3. only later do selected suggestions feed higher-level reads or state changes

## Working framing

Better framing:
- "weekly notes review"
- "context distillation"
- "work memory review"

Less healthy framing:
- "cron updates projects/apps from notes"

## Short product rule

**Notes should feed proposal artifacts before they ever feed canonical state.**
