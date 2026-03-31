# Mission Control Intelligence Layer — Promotion Logic Spec (v1)

## 1. Purpose

This document defines how an **intelligence contract** becomes a **proposal artifact** in Mission Control.

It is the behavioral layer that sits between:
- contract generation (detectors compute structured candidate findings)
- artifact persistence and review (humans see, accept, dismiss, or ignore proposals)

The goal is to make promotion behavior:
- deterministic
- idempotent
- deduplicated
- review-safe
- legible to implementers

This is the load-bearing workflow spec for v1. The SQL schema and MCP tool contracts should follow from these rules, not precede them.

## 2. Scope

This v1 spec applies only to the four contract types currently in scope:
- `follow_up_risk`
- `blocked_waiting_stale`
- `stale_task`
- `ambiguous_task`

Planned next addition after v1 stabilization:
- `recently_unblocked` *(planned Phase 6 addition; not implemented in v1)*

Out of scope for v1:
- reminder delivery policy beyond artifact creation/update behavior
- ranking/scoring models beyond what contracts already compute
- cross-household or multi-tenant concerns
- fully generic grouping across arbitrary future contract types

## 3. Core model

### 3.1 Intelligence contract

An intelligence contract is a detector-produced, machine-structured finding about a specific subject.

It is:
- typed
- evidence-backed
- recomputable
- not yet a user-facing review object by itself

### 3.2 Proposal artifact

A proposal artifact is the persisted, review-facing object shown to a human.

It is:
- curated for legibility
- action-bearing
- statusful
- durable across runs

### 3.3 Promotion

Promotion is the decision process that takes one or more contracts and either:
- creates a new artifact
- updates an existing open artifact
- suppresses promotion because an open artifact already covers the subject/family
- records no artifact because the candidate does not clear promotion rules

## 4. Design principles

### 4.1 Proposal-first, never silent state mutation

Promotion creates or updates review artifacts. It does not silently mutate canonical task/project/application state.

### 4.2 One open concern per subject/family, unless explicitly distinct

The system should avoid spawning multiple simultaneously-open artifacts that represent the same practical review burden.

### 4.3 Contracts are detector truth; artifacts are review truth

Contracts preserve detector output. Artifacts present the reviewable expression of that output.

### 4.4 Idempotency is required, not aspirational

The same scheduled run firing twice must not create duplicate open artifacts. Regenerated contracts for the same unresolved concern must converge on the same open artifact unless an explicit rule says otherwise.

### 4.5 Grouping is an explicit decision

If multiple contracts combine into one artifact, that grouping must be intentional, rule-based, and reflected in provenance.

## 5. Promotion pipeline

For each detector run, promotion proceeds in this order:

1. **Generate contracts** for in-scope detectors.
2. **Normalize subject identity** for each contract.
3. **Compute promotion family key** for dedupe/suppression.
4. **Evaluate grouping rules** where applicable.
5. **Check for existing open artifact** for that family key.
6. If none exists, **create** a new artifact.
7. If one exists, **update or suppress** according to idempotency/update rules.
8. **Record provenance** linking source contracts to the artifact decision.

This order is normative.

## 6. Subject identity and family key

The central dedupe decision in v1 is the distinction between:
- the **contract subject**: what the detector found something about
- the **promotion family**: the review burden the system wants to avoid duplicating

These are related but not always identical.

### 6.1 Subject identity

Each contract must resolve to a normalized subject identity appropriate to its type.

Examples:
- `follow_up_risk` → likely a thread, conversation, or waiting-on relationship
- `blocked_waiting_stale` → likely a blocked task or project item
- `recently_unblocked` *(planned Phase 6 addition)* → a task whose previously-blocking dependency was recently cleared
- `stale_task` → the task itself
- `ambiguous_task` → the task itself

The exact entity fields live in the contract schema. Promotion logic uses those fields but does not redefine them.

### 6.2 Promotion family key

Every contract eligible for promotion must compute a **promotionFamilyKey**.

In v1, the key is:

`contractType + canonicalSubjectKey`

Where:
- `contractType` is one of the four allowed contract types
- `canonicalSubjectKey` is the normalized identity of the review target for that contract type

### 6.3 Why not use a more generic or looser key?

The family key is intentionally **type-scoped** in v1.

That means:
- a `stale_task` contract and an `ambiguous_task` contract about the same task are **not** automatically deduped as the same family
- they may still be grouped into one artifact if grouping rules say so
- but dedupe and idempotency should not depend on implicit cross-type semantics

This keeps v1 behavior explicit and testable.

### 6.4 When subjectRole belongs in the key

If a contract type uses `subjectRole` in a way that changes the practical review burden, then `subjectRole` must be part of `canonicalSubjectKey`.

Rule:
- include `subjectRole` when changing it would mean “this is a meaningfully different concern a human might want to review separately”
- exclude it when it is explanatory metadata rather than identity

For v1, implementers should not guess. The contract-type-specific promotion mapping must define this explicitly.

### 6.5 Contract-type-specific family key guidance (v1)

#### Planned Phase 6: `recently_unblocked`
Family key should identify the task that became actionable again after a blocking dependency cleared.

Recommended canonicalSubjectKey:
- `task:{taskId}`

Planned payload emphasis:
- which dependency cleared
- when it cleared
- how long the task had been blocked before clearing
- current task status after unblocking
- the recommended next-action window

Placement note:
- this belongs in the follow-up / reminder family alongside `follow_up_risk` and `blocked_waiting_stale`
- it is a planned addition, not part of the implemented v1 contract set

#### `stale_task`
Family key should identify the task itself.

Recommended canonicalSubjectKey:
- `task:{taskId}`

#### `ambiguous_task`
Family key should identify the task itself.

Recommended canonicalSubjectKey:
- `task:{taskId}`

#### `blocked_waiting_stale`
Family key should identify the blocked item whose stale waiting state is under review.

Recommended canonicalSubjectKey:
- `task:{taskId}` or equivalent blocked-work-item identifier

If the same task can be waiting on multiple distinct external dependencies and those should be reviewed separately, that dependency identity must be included explicitly. Do not leave this implicit.

#### `follow_up_risk`
Family key should identify the concrete follow-up subject being reviewed.

Recommended canonicalSubjectKey:
- `thread:{threadId}`
- or `waiting_on:{personId}:{topicId}`
- or another normalized follow-up identity

If the contract schema exposes a `subjectRole` that materially changes review meaning, include it here.

## 7. Promotion eligibility rules

A contract is promotable if all of the following are true:
- contract schema validates
- required evidence is present
- required subject identity can be normalized
- severity/confidence meets the minimum threshold defined for that detector family
- the contract is not explicitly suppressed by a higher-priority open artifact rule

If any of these fail, no artifact should be created.

The failed decision should still be recordable in logs or internal provenance where practical.

## 8. Deduplication rules

### 8.1 Open artifact dedupe rule

At most **one open artifact per promotionFamilyKey** may exist at a time unless a contract-type-specific rule explicitly allows otherwise.

That is the default v1 dedupe rule.

### 8.2 What counts as open

For dedupe/suppression, an artifact counts as open if its status is one of:
- `open`
- `accepted`
- `applied` only if the system still considers it active and unresolved in workflow terms

Recommended v1 default:
- dedupe against `open`
- do **not** dedupe against `accepted` or `applied` if those states mean the proposal has already moved forward and should no longer block fresh detection

However, the status model in section 11 is normative. Implementers should keep these aligned rather than inventing separate meanings.

### 8.3 Exact matching rule

For v1, dedupe matching is **exactly**:

`existingArtifact.promotionFamilyKey === candidate.promotionFamilyKey`

Not fuzzy. Not “similar enough.”

If broader suppression is desired across multiple related families, that belongs in grouping or explicit suppression rules, not ad hoc dedupe logic.

### 8.4 Consequence

A `stale_task` artifact and an `ambiguous_task` artifact for the same task are different families by default because their `contractType` differs.

They may be:
- shown separately
- or grouped into one combined artifact if a grouping rule says so

But they are not automatically deduped into one record solely because the task is shared.

## 9. Idempotency rules

Idempotency governs repeated runs and regenerated contracts.

### 9.1 Required invariant

For the same unresolved underlying concern, repeated detector execution must converge on the same open artifact rather than creating duplicates.

### 9.2 Idempotent create/update behavior

When a promotable contract is evaluated:

- **If no open artifact exists** for the promotionFamilyKey:
  - create a new artifact
- **If an open artifact exists** for the promotionFamilyKey:
  - update that artifact in place if the newly generated contract materially changes the review-facing content
  - otherwise record provenance/no-op and leave the artifact unchanged

### 9.3 What counts as material change

A material change is any change that should alter a human's review experience, including:
- severity or urgency changes that affect framing
- key dates crossing thresholds
- summary/reason changes
- evidence set changes that affect the review-facing curated evidence
- recommended actions changing
- grouped contract membership changing

Non-material changes include:
- recomputation timestamp only
- reordered evidence with no semantic change
- detector-internal bookkeeping changes that do not affect review content

### 9.4 Worked example: scheduled run fires twice

#### Scenario
A nightly job runs at 02:00 and, due to scheduler retry behavior, runs again at 02:03.

At 02:00 the detector emits:
- contractType: `stale_task`
- taskId: `task_123`
- promotionFamilyKey: `stale_task|task:task_123`

Promotion finds no existing open artifact and creates:
- artifact `art_9001`
- status: `open`
- promotionFamilyKey: `stale_task|task:task_123`

At 02:03 the detector emits the same effective contract again.

#### Required outcome
Promotion must:
- find `art_9001` by exact promotionFamilyKey match
- determine there is no material review-facing change
- not create `art_9002`
- record a no-op/update-suppressed provenance event if supported

#### Result
There is still exactly one open artifact for that stale task concern.

### 9.5 Worked example: contract regenerates before previous artifact expires

#### Scenario
A `follow_up_risk` artifact already exists for a thread awaiting reply.

Existing artifact:
- artifactId: `art_501`
- contractType: `follow_up_risk`
- promotionFamilyKey: `follow_up_risk|thread:thr_88`
- status: `open`
- summary: “No reply from vendor in 6 days; follow-up likely needed.”

Two days later, the detector runs again.
New contract computes:
- same thread identity
- same family key
- stronger urgency because now 8 days have passed
- updated curated evidence including the newer elapsed-time fact

#### Required outcome
Promotion must:
- match the existing open artifact by exact family key
- update `art_501` in place
- refresh review-facing fields such as summary, urgency, and artifact evidence
- append provenance linking the new contract version to the existing artifact
- not create a second open follow-up artifact for the same thread

#### Result
The human sees one evolving artifact, not a stack of near-duplicates.

## 10. Grouping rules

Grouping is separate from dedupe.

Dedupe answers: “is this the same open concern?”
Grouping answers: “should multiple contracts be presented as one review artifact?”

### 10.1 Default v1 behavior

Default behavior is **no grouping unless an explicit grouping rule applies**.

This avoids accidental semantic collapse.

### 10.2 Allowed grouping shape

A grouped artifact may be produced when:
- multiple contracts refer to the same review subject
- presenting them together is clearer than presenting them separately
- the grouped artifact still supports a coherent human decision

### 10.3 Recommended v1 grouping boundary

For v1, grouping should be conservative and limited to:
- same normalized subject
- same review surface
- same review window/run cohort when relevant
- compatible actions

If combining contracts would produce muddled or conflicting actions, do not group them.

### 10.4 Provenance requirement for grouped artifacts

If an artifact is grouped, provenance must record:
- all source contract ids/types involved
- which contract was primary for summary framing, if applicable
- the grouped subject identity
- the grouping decision timestamp/run id

### 10.5 Example: when grouping is allowed

A task may emit:
- `stale_task`
- `ambiguous_task`

If product chooses that reviewing them together is clearer, one grouped artifact could say:
- this task is both stale and underspecified
- suggested actions: clarify it, re-commit it, or dismiss the concern

In that case provenance must explicitly show both source contracts.

### 10.6 Example: when grouping is not allowed

A `follow_up_risk` contract on a message thread and a `stale_task` contract on a planning task may mention the same project, but they should not be grouped just because they share project context. The review burden is different.

## 11. Suppression rules at promotion time

Suppression means a candidate contract does not create a new artifact because an existing artifact already covers the relevant review burden.

### 11.1 Base suppression rule

Do not create a new open artifact if an open artifact already exists for the same promotionFamilyKey.

Instead:
- update the existing artifact if materially changed
- otherwise no-op

### 11.2 Family-level suppression for grouped artifacts

If grouping rules produce a grouped artifact that is intended to subsume multiple contract families, the grouped artifact must explicitly record the families it covers.

In that case, promotion of a later contract in one of those covered families should:
- update the grouped artifact, or
- no-op
- not create a parallel open child artifact unless a split rule explicitly allows it

### 11.3 No vague suppression

Do not suppress because something “feels related.”
Suppression must be explainable by one of:
- exact family key match
- explicit grouped-family coverage
- explicit contract-type suppression rule

## 12. Artifact evidence at promotion time

Contract evidence and artifact evidence are not the same thing.

### 12.1 Contract evidence

Contract evidence supports the detector's computation and may be broader, more technical, or more complete.

### 12.2 Artifact evidence

Artifact evidence is the **curated, review-facing subset** of contract evidence selected for human legibility and decision usefulness.

It should:
- include the facts needed to justify the proposal
- omit unnecessary detector exhaust
- not be a wholesale copy by default

### 12.3 Promotion rule

When creating or updating an artifact, the system must select artifact evidence intentionally from source contract evidence.

If grouped from multiple contracts, the artifact evidence may draw from more than one source contract, but should still remain curated.

## 13. Suggested actions requirement

Open artifacts must expose review-complete actions.

For v1, that means an open artifact must support both:
- `accept`
- `dismiss`

Additional actions may exist, but these two are mandatory.

### 13.1 Validation note

If the schema only enforces `suggestedActions.min(1)`, that is not sufficient to express the full business rule.

Therefore this requirement must be enforced either:
- as an explicit schema refinement, or
- as a runtime validation rule during artifact creation/update

Implementers must not assume `.min(1)` is enough.

## 14. Status transition rules

### 14.1 Status set

v1 statuses:
- `open`
- `accepted`
- `applied`
- `dismissed`
- `expired`

### 14.2 Meaning

#### `open`
Artifact is awaiting human review.

Allowed entries into `open`:
- newly promoted artifact
- optionally reopened artifact in a future version (not required in v1)

#### `accepted`
Human accepted the proposal as a valid action/review item.
This means “yes, this proposal is real and should proceed,” not “the downstream state change is finished.”

#### `applied`
The accepted proposal has been carried through into its intended downstream effect.

Examples:
- reminder scheduled
- task updated
- proposal converted into an approved state mutation

#### `dismissed`
Human explicitly rejected the proposal.
This is not the same as expiration.

#### `expired`
Artifact aged out or became irrelevant without being accepted/applied.

### 14.3 Allowed transitions

Allowed transitions in v1:
- `open -> accepted`
- `open -> dismissed`
- `open -> expired`
- `accepted -> applied`
- `accepted -> expired` if the accepted plan became stale before application

Optionally allowed only if product explicitly wants it later:
- `accepted -> open` (reopen)
- `applied -> expired` (historical lifecycle close-out)

### 14.4 Disallowed transitions

Disallowed by default in v1:
- `dismissed -> accepted`
- `dismissed -> applied`
- `expired -> accepted`
- `expired -> applied`
- `applied -> open`

If a new concern emerges after dismissal/expiry, it should usually create or update a fresh artifact based on current detector output, not resurrect an old one silently.

## 15. Interaction between status and future promotion

### 15.1 If prior artifact is `open`
Match by family key and update/no-op. Do not create a duplicate.

### 15.2 If prior artifact is `accepted`
By default, do not create a new artifact for the same family while the accepted artifact is still the active representation of that concern.

Recommended v1 implementation:
- treat `accepted` as still suppressing fresh promotion until it becomes `applied` or `expired`
- update it if materially needed, or record a no-op

This keeps “accepted but not yet executed” concerns from duplicating.

### 15.3 If prior artifact is `applied`
A fresh contract may create a new artifact only if it represents a genuinely new occurrence of the concern rather than the already-applied one persisting in history.

This requires contract-type judgment. Implementers should prefer explicit occurrence/version boundaries rather than heuristics.

### 15.4 If prior artifact is `dismissed`
A new artifact may be created if the detector later emits a new promotable contract for the same family.

However, if product wants dismissal cooldown behavior, that should be defined explicitly as a future suppression rule rather than improvised.

### 15.5 If prior artifact is `expired`
A new promotable contract may create a fresh artifact.

## 16. Worked examples

### 16.1 `stale_task` basic promotion

Contract:
- type: `stale_task`
- taskId: `task_42`
- family key: `stale_task|task:task_42`
- evidence: task has seen no meaningful progress in 19 days

No open artifact exists.

Outcome:
- create one open artifact
- artifact evidence is curated to the key stale facts
- suggested actions include at least accept + dismiss

### 16.2 `stale_task` rerun with no change

Same contract regenerated next night.

Outcome:
- find open artifact by exact family key
- no new artifact created
- no-op or lightweight provenance append only

### 16.3 `ambiguous_task` on same task

Contract:
- type: `ambiguous_task`
- taskId: `task_42`
- family key: `ambiguous_task|task:task_42`

Outcome by default:
- this is a different family from `stale_task|task:task_42`
- create a separate artifact unless explicit grouping rule combines them

### 16.4 grouped stale + ambiguous task artifact

Product decides these two contract types should be grouped for the same task.

Contracts:
- `stale_task|task:task_42`
- `ambiguous_task|task:task_42`

Outcome:
- create one grouped open artifact covering both families
- provenance lists both contracts
- future promotion of either family updates that grouped artifact rather than creating a duplicate sibling

### 16.5 `follow_up_risk` regeneration before expiry

Contract for thread `thr_88` produces follow-up concern Monday and again Wednesday with stronger urgency.

Outcome:
- exact family key match
- update same open artifact in place
- refresh summary/evidence/urgency
- preserve one coherent review object

### 16.6 `blocked_waiting_stale` after dismissal

A blocked waiting artifact was dismissed because the user knew the blocker was temporary.
A week later the item is still blocked and the detector emits a fresh contract.

Outcome in v1:
- a new artifact may be created
- dismissal does not permanently blacklist the family
- any cooldown behavior would need an explicit future rule

## 17. Persistence implications (non-normative but strongly recommended)

The data model should persist enough to support the above behavior, including:
- artifact status
- promotionFamilyKey
- source contract ids/versions
- grouped-family coverage, if grouping occurs
- timestamps for create/update/expire/dismiss/apply
- a way to distinguish no-op reruns from material artifact updates

## 18. Minimum test matrix

Implementers should treat the following as required tests for v1:

1. **Exact dedupe**
   - same contract type + same normalized subject -> no duplicate open artifact

2. **Cross-type non-dedupe by default**
   - `stale_task` and `ambiguous_task` on same task do not collapse unless grouping enabled

3. **Double-run idempotency**
   - scheduler firing twice does not produce duplicate artifacts

4. **In-place update on material regeneration**
   - same family, stronger urgency -> existing open artifact updates

5. **No-op on non-material regeneration**
   - same family, no user-visible change -> no duplicate, no material update

6. **Grouped artifact provenance**
   - grouped artifact records all source contracts and covered families

7. **Suppression by grouped coverage**
   - later contract already covered by grouped open artifact does not create sibling duplicate

8. **Status transition enforcement**
   - allowed transitions succeed; disallowed transitions fail

9. **Open artifact action completeness**
   - open artifacts expose both accept and dismiss

10. **Artifact evidence curation**
   - artifact evidence is a deliberate review-facing subset, not blind full-copy behavior

## 19. v1 implementation stance

If an implementer is uncertain between:
- looser implicit behavior
- stricter explicit behavior

choose the stricter explicit behavior.

In particular:
- prefer exact family-key matching over fuzzy dedupe
- prefer no grouping over accidental grouping
- prefer updating a single open artifact over creating near-duplicates
- prefer explicit provenance over inferred behavior

## 20. Short version

The v1 rule set is:
- contracts compute findings
- promotion maps each finding to an explicit type-scoped family key
- only one active artifact should represent a family at a time unless grouping rules explicitly change that
- repeated runs must update/no-op, not duplicate
- grouping must be intentional and provenance-backed
- artifact evidence is curated for review, not copied wholesale from contract evidence
- open artifacts must support real review actions
- status transitions must be explicit and constrained

That is the behavior package required before schema, tables, and MCP tools can be implemented cleanly.
