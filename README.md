# Akea Hotel Operations Platform

White-label hotel operations platform for US hotel owners and management companies.

| Part | Where | What |
|---|---|---|
| `web/` | Render (static site) | The portal: dashboards, report inbox, hotels, users, company info, branding |
| Database, logins, files | Supabase project `rqyvjloptxdfojaxjirq` (US East) | Postgres with row-level security per company, auth, storage |
| `mobile/` | Expo (coming) | iPhone and Android staff app |

## Web portal
- `cd web && npm install && npm run build` → static files in `web/dist`.
- Talks to Supabase directly from the browser using the public (publishable) key. Every table is protected by row-level security, so a user only ever sees their own company and the hotels they're assigned.
- Env vars (optional, defaults are the production project): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.

## Access model
- **Company (tenant)** → hotels → users. A user's access = **role** (what) + **hotels** (where).
- People are invited by email (Users & Permissions). When they create an account with that email, their access is applied automatically.

## Status
Phase 1 (core): sign-in, portfolio and hotel dashboards, STR, report inbox (upload and storage), hotels, users and invites, company information, white-label branding.
Figures marked **sample data** are generated examples until real reports are uploaded.
