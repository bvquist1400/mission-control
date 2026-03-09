# Baseline (Mission Control)

> **Maintenance:** Keep this file and `AGENTS.md` in sync. Update both when adding new architectural patterns, key files, migrations, or environment variables. This is a living conventions doc, not a changelog.

Personal productivity and project management platform for tracking implementations, projects, tasks, stakeholders, commitments, and calendar events.

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

## Data Hierarchy

```
Implementation (Application) -> Project -> Task
```

## Architecture Rules

### API Routes

- Auth: use `requireAuthenticatedRoute()` from `@/lib/supabase/route-auth`
- CORS: wrap all responses with `withCorsHeaders()` from `@/lib/cors`
- PATCH: always use an explicit `allowedFields` allowlist
- Supabase queries: always filter by `user_id`

### Database

- RLS: 4-policy pattern (SELECT, INSERT, UPDATE, DELETE) on every table
- `updated_at` triggers: reuse `set_updated_at()` function
- Migrations: `supabase/migrations/` (latest: 027)

### MCP Server

- Stateless per-request transports with `enableJsonResponse: true`
- Tools call the HTTP API internally via fetch
- Responses wrapped with `toMcpResponse()` which adds `current_time_et`
- Proxy deployment (`DEPLOYMENT_ROLE=mcp`) at `mission-control-mcp.vercel.app`
- Proxy must: strip `content-encoding`/`transfer-encoding`/`content-length` from upstream headers, add CORS headers explicitly, use `sessionIdGenerator` (clients require `mcp-session-id`)
- OAuth: RFC 8414/9728 flow with PKCE, dynamic client registration, token rotation
- OAuth redirects must use status 302 (not Next.js default 307)

### UI Conventions

- Theme tokens: `text-foreground`, `text-muted-foreground`, `bg-panel`, `bg-panel-muted`, `border-stroke`, `rounded-card`, `bg-accent`
- Cards: `<article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">`
- Page headers: `<PageHeader title="..." description="..." actions={...} />`
- Primary buttons: `bg-accent text-white hover:opacity-90`
- Secondary buttons: `border border-stroke bg-panel text-muted-foreground hover:bg-panel-muted`
- Detail pages: server component wraps params, passes id to client component

## Key Files

| Purpose | Path |
|---|---|
| Database types | `src/types/database.ts` |
| Sidebar nav | `src/components/layout/Sidebar.tsx` |
| MCP server (all tools) | `src/app/api/mcp/route.ts` |
| MCP OAuth | `src/lib/mcp/oauth.ts` |
| MCP proxy config | `src/lib/mcp/config.ts` |
| OAuth routes | `src/app/oauth/` |
| CORS | `src/lib/cors.ts` |
| Route auth | `src/lib/supabase/route-auth.ts` |
| Calendar parsing | `src/lib/calendar.ts` |
| Upstream API router | `src/app/api/mcp-upstream/[...path]/route.ts` |

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
