# Baseline (Mission Control) — Agent Instructions

This file mirrors `CLAUDE.md` for AI agents that don't read that format (ChatGPT, GitHub Copilot, Cursor, Windsurf, etc.). Keep both files in sync when making architectural changes.

## Stack

- **Framework:** Next.js 16 App Router (Turbopack)
- **Database:** Supabase (PostgreSQL + Auth + RLS)
- **Styling:** Tailwind CSS with custom theme tokens
- **Deployment:** Vercel (two deployments — main app + MCP proxy)
- **MCP:** Model Context Protocol server with OAuth, used by Claude.ai and ChatGPT

## Commands

```bash
npm run dev          # Local dev server
npm run build        # Production build (runs tsc)
npx tsc --noEmit     # Type-check without building
```

## Priority Model

- `tasks.base_priority` is the un-boosted base (0-100); `tasks.priority_score` is always derived as `clamp(base_priority + boosts, 0, 100)` via `recalculateTaskPriority()` in `src/lib/priority.ts`.
- Never feed `priority_score` back in as the base — that recreates the pre-migration-044 compounding bug.
- API `priority_score` inputs (create/PATCH/MCP) set `base_priority`; the stored score is recomputed server-side.

## Data Hierarchy

```
Implementation (Application) -> Project -> Task
```

Hierarchy is DB-enforced (migration 046, project wins): a task in a project inherits the project's `implementation_id` via trigger; re-pointing a project cascades to its tasks. Caller-supplied `implementation_id` is overridden when the project has an application; kept only when the project has none or the task has no project.

External task identities are stored as the nullable pair `external_source_system` + `external_source_id`. Migration 054 enforces user-scoped uniqueness; callers must never assign an external ID without its source-system namespace.

## Architecture Rules

### API Routes

- Auth: use `requireAuthenticatedRoute()` from `@/lib/supabase/route-auth`
- CORS: wrap all responses with `withCorsHeaders()` from `@/lib/cors`
- PATCH: always use an explicit `allowedFields` allowlist
- Not-found checks: only translate PGRST116 into 404 (use `isPostgrestNotFound()` from `@/lib/supabase/errors`); rethrow other errors as 500s
- Timestamp inputs: validate with `validateOptionalTimestamp()` from `@/lib/validate` before insert/update
- Secret/API-key comparisons: use `secureCompare()` from `@/lib/secure-compare`, never `===`
- Supabase queries: always filter by `user_id`

### Database

- RLS: 4-policy pattern (SELECT, INSERT, UPDATE, DELETE) on every table
- `updated_at` triggers: reuse `set_updated_at()` function
- Migrations: `supabase/migrations/` (latest: 055)
- New tables get explicit `GRANT ... TO authenticated, service_role` (see 055): newer Supabase stacks, including a fresh `supabase start`, no longer auto-grant public tables to the API roles

### Schema Types

- `src/types/supabase.generated.ts` is generated truth — never edit by hand. Regenerate after every migration: `npm run gen:types`; verify with `npm run test:types-drift`.
- `src/types/database.ts` remains the domain layer (narrowed unions like `TaskStatus`); `src/types/type-assertions.ts` compile-time-pins its row interfaces to the generated schema (key parity + nullability), so `npx tsc --noEmit` fails on drift.
- Supabase clients are typed with `<Database>` — inserts/updates are schema- and enum-checked at compile time. JSONB domain shapes (e.g. `TaskRecurrence`) cast via `as unknown as Json` at the write boundary.

### MCP Server

- Stateless per-request transports with `enableJsonResponse: true`
- Tools call the HTTP API internally via fetch
- Responses wrapped with `toMcpResponse()` which adds `current_time_et`
- Tool surface is a live contract: `npm run test:mcp-contract` diffs tool names + input schemas against `scripts/fixtures/mcp-tools.snapshot.json`; rerun with `--update` and commit when a change is intentional
- Proxy deployment (`DEPLOYMENT_ROLE=mcp`) at `mission-control-mcp.vercel.app`
- Proxy must: strip `content-encoding`/`transfer-encoding`/`content-length` from upstream headers, add CORS headers explicitly, use `sessionIdGenerator` (clients require `mcp-session-id`)
- OAuth: RFC 8414/9728 flow with PKCE, dynamic client registration, token rotation
- OAuth redirects must use status 302 (not Next.js default 307)

### UI Conventions

**Use the UI primitives — do not hand-style controls.**

| Need | Use |
|---|---|
| Button | `<Button variant="primary\|secondary\|danger\|success\|ghost" size="icon\|xs\|sm\|md\|lg">` (`@/components/ui/Button`) |
| Segmented control / tab strip | `<Button variant="toggle" active={isSelected}>` — sets `aria-pressed` for you |
| Icon-only button | `<Button variant="ghost" size="icon" aria-label="…">` |
| Button-styled `<Link>`/anchor | `buttonClasses({ variant, size })` |
| Text field / textarea / select | `<Input>` / `<Textarea>` / `<Select>` with `tone="default\|muted"`, `size="xs\|sm\|md"` (`@/components/ui/Field`) |
| Card surface | `className={cardClasses({ padding: "sm\|md\|lg" })}`, or `<Card as="section">` (`@/components/ui/Card`) |
| Pill / badge | `className={badgeClasses({ tone, size })}`, or `<Badge>` (`@/components/ui/Badge`) |
| Transient feedback | `useToast()` (`@/components/ui/Toast`) — never `window.confirm`/`alert` |
| Task mutation | `useTaskMutation()` (`@/hooks/useTaskMutation`) — owns optimism, rollback, undo |

Controls with behaviour (Button, Input) are components; pure-styling primitives (Card, Badge) expose class functions so the semantic element stays the author's choice.

- A primitive's `className` prop is for **layout only** (margin, width, flex/grid placement). Every colour, padding, radius and font size is a `variant`/`size`/`tone` prop — there is no `tailwind-merge`, so a conflicting utility passed via `className` will not reliably win. Add a variant instead.
- Theme tokens: `text-foreground`, `text-muted-foreground`, `bg-panel`, `bg-panel-muted`, `border-stroke`, `rounded-card`, `bg-accent`
- Semantic tokens: `danger`, `warning`, `success` — each with `text-*`, `bg-*-soft`, `border-*-border` (danger also has `bg-danger-soft-hover`). Never reach for raw Tailwind palette shades (`bg-red-50`, `text-slate-700`, `bg-amber-50`): the app is dark-only, and those render as pale light-mode boxes. For accents on dark, the `bg-*-500/15` + `text-*-300` pattern is fine.
- `bg-accent` is a **fill-only** token: white on it is 5.84:1, but as text it is 2.96:1 on `bg-panel`. For accent-coloured type, icons or rings use **`text-accent-text`** (6.2:1).
- Focus: a global unlayered `:focus-visible` outline lives in `globals.css`. Do not add `outline-none` without a visible replacement, and do not add `focus:ring-*` — the outline covers it.
- Type floor: `text-xs` is the smallest size in the app. Do not reintroduce `text-[10px]`/`text-[11px]`.
- Page headers: `<PageHeader title="..." description="..." actions={...} />`
- Detail pages: server component wraps params, passes id to client component

### Navigation & shortcuts

- Nav lives in **one** place: `src/components/layout/nav-items.tsx` (`NAV_GROUPS`). The desktop rail, mobile drawer and tablet bar all render from it — never add a link to only one of them.
- Adding a route means adding it to `NAV_GROUPS`, or deliberately leaving it unlinked (`/triage` and `/implementations` are intentional redirect shims).
- Sidebar collapse state is a **cookie** (`baseline_sidebar`), read in `src/app/layout.tsx` so the rail renders at its final width server-side. Don't move it to localStorage — that reintroduces the expand-then-collapse flash.
- Global shortcuts live in `Sidebar.tsx`: `⌘/Ctrl+K` search, `[` collapse, `?` help, `g` + key to navigate (`GO_TO_KEYS` in `ShortcutsDialog.tsx`). Any new shortcut must be added to the `?` dialog in the same change, and must no-op while the user is typing in a field.

### Today page architecture

- `src/app/page.tsx` is a server component: it resolves the Supabase user
  (redirect to `/login`), renders `PageHeader` + `FocusStatusBar`, then streams
  each section inside its own `<Suspense>` boundary.
- Sections live in `src/components/today/sections/`. Each is an async server
  component (`NowPanelSection`, `MeetingsSection`, `WeekBoardSection`,
  `WaitingStripSection`, `TodayHeaderChips`) that awaits the shared query layer
  and either renders a server-only card or hydrates a client island (`NowPanel`,
  `WeekBoard`, `WaitingStrip`) with fetched data as props.
- All Today data comes from `src/lib/today/queries.ts` (the same functions back
  the `/api/tasks?view=…`, `/api/calendar/today`, and
  `/api/planner/sync-today/latest` routes). Server-side rendering uses ET
  (`DEFAULT_WORKDAY_CONFIG.timezone`); there is no client timezone plumbing.
- `TodayModalProvider` (client context) owns the single `TaskDetailModal`; any
  island opens a task via `useTodayModal().openTask` and registers its tasks via
  `registerTasks`. Mutations PATCH then call `router.refresh()` to re-stream the
  affected sections.

### Brief pages

- A brief (`briefs`, migration 055) is content-as-data plus numbered items (`brief_items`) with a stable `item_key` and a state. Codes look like `EOD-0924`.
- `src/lib/briefs/service.ts` is the only write path: `/api/briefs` (POST save, GET/PATCH by code) and the MCP tools `save_eod_brief`, `get_brief`, `act_on_brief_items` all go through it. Validate every action before executing any.
- Proposals are never tasks until accepted. Accept creates the task with external source (`eod_proposal`, `item_key`), idempotent via the 054 index. A same-day re-save only appends items from uncovered meetings; existing `n` and state never change.
- "Tomorrow" is the next ET weekday (`resolveTomorrowDate` in `src/lib/briefs/keys.ts`), never UTC.
- The page renders from registries, never from the edition: `CARD_REGISTRY` (item kind → card, `src/components/briefs/cards.tsx`) and `TILE_REGISTRY` (read-only tile type → tile, `tiles.tsx`). Adding a kind means the registry plus the migration's kind check.
- `/briefs/*` renders full-bleed (no sidebar) via `AppShell`; its styles are scoped under `.brief-page` and follow the OS light/dark setting, unlike the rest of the app. Page-local keys (J/K/A/D/S) are listed on the page, not in the global `?` dialog.
- Tests: `npm run test:briefs` (pure) and `npm run test:briefs-db` (needs a local Supabase stack; refuses non-local URLs).

## Key Files

| Purpose | Path |
|---|---|
| Database types | `src/types/database.ts` |
| Recurrence rules | `src/lib/recurrence.ts` |
| Recurring generator | `src/lib/recurring-task-generator.ts` |
| Notes service surface | `src/lib/notes.ts` |
| Notes shared helpers | `src/lib/notes-shared.ts` |
| Notes relation helpers | `src/lib/notes-relations.ts` |
| Calendar event identity helper | `src/lib/calendar-event-identity.ts` |
| Sidebar nav | `src/components/layout/Sidebar.tsx` |
| Today page (server shell) | `src/app/page.tsx` |
| Today shared query layer | `src/lib/today/queries.ts` |
| Today server/client sections | `src/components/today/sections/` |
| Today shared modal provider | `src/components/today/TodayModalProvider.tsx` |
| MCP server (all tools) | `src/app/api/mcp/route.ts` |
| MCP OAuth | `src/lib/mcp/oauth.ts` |
| MCP proxy config | `src/lib/mcp/config.ts` |
| OAuth routes | `src/app/oauth/` |
| CORS | `src/lib/cors.ts` |
| Route auth | `src/lib/supabase/route-auth.ts` |
| Calendar parsing | `src/lib/calendar.ts` |
| Daily brief digest builder | `src/lib/briefing/digest.ts` |
| Daily brief digest route | `src/app/api/briefing/digest/route.ts` |
| Daily brief render builder | `src/lib/briefing/render.ts` |
| Daily brief render route | `src/app/api/briefing/render/route.ts` |
| Review snapshot rollups | `src/lib/briefing/review-snapshots.ts` |
| Project status update route | `src/app/api/project-status-updates/route.ts` |
| Weekly review route | `src/app/api/briefing/weekly-review/route.ts` |
| Monthly review route | `src/app/api/briefing/monthly-review/route.ts` |
| Review automation workflow export | `n8n/mission-control-project-reviews.json` |
| Notes schema migration | `supabase/migrations/032_add_notes.sql` |
| Upstream API router | `src/app/api/mcp-upstream/[...path]/route.ts` |
| Brief pages service (save / get / act) | `src/lib/briefs/service.ts` |
| Brief page (`/briefs/[code]`) | `src/app/briefs/[code]/page.tsx`, `src/components/briefs/` |
| EOD routine prompt | `docs/routines/eod.md` |

## Briefing Model Note

- `briefing_narrative` is lib-controlled, not user-configured in the database.
- To change the model used for daily brief email narration, edit `LIB_CONTROLLED_FEATURE_MODELS.briefing_narrative` in `src/lib/llm/catalog.ts`.
- The current daily brief email flow expects Mission Control to generate the narrative server-side before n8n sends the email.

## Review Automation Note

- Daily project review history is stored in `project_status_updates`.
- Weekly and monthly review snapshots are stored in `briefing_review_snapshots`.
- The daily project review n8n branch calls Anthropic directly to generate strict JSON summaries per project.
- Weekly and monthly review endpoints are deterministic server-side rollups; n8n only formats and sends the emails.
- Never commit live machine keys or provider API keys into tracked n8n workflow exports.

## Calendar

- Source: M365 published ICS feed via `WORK_ICAL_URL` env var
- ICS feed does NOT include ATTENDEE/ORGANIZER properties (Microsoft strips them)
- Attendee names only available if embedded in event title

## Environment Variables (key ones)

- `DEPLOYMENT_ROLE` — `main` or `mcp`
- `MCP_UPSTREAM_API_URL` — upstream URL for proxy mode
- `MCP_CANONICAL_APP_URL` — public-facing URL for OAuth metadata
- `CALENDAR_SOURCE` — `local`, `ical`, or `none`
- `WORK_ICAL_URL` — remote ICS feed URL
- `MISSION_CONTROL_API_KEY` — legacy MCP auth
- `MISSION_CONTROL_USER_ID` — legacy MCP user binding
