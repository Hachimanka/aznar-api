# aznar-api — shared backend for AZONE and APAY

Express 5 + TypeScript + **Supabase (PostgreSQL)** via Drizzle ORM. One API, two route groups:

| Prefix   | Used by | Who can call it |
|----------|---------|-----------------|
| `/auth`  | both    | anyone (login) |
| `/azone` | AZONE (employee app) | any account linked to an employee — only their own data |
| `/apay`  | APAY (payroll app)   | staff roles only: `payroll_admin`, `hr`, `finance`, `management` |

The payroll engine (`src/lib/payroll.ts`) runs **here**. APAY only displays results.

## Connect to your Supabase project

1. In Supabase, click **Connect** (top bar) → **Connection string**. Copy two strings, replacing
   `[YOUR-PASSWORD]` with your database password (Project Settings → Database → reset it if you don't know it):
   - **Transaction pooler** (port **6543**) → `DATABASE_URL` — used by the API
   - **Session pooler** (port **5432**) → `DIRECT_URL` — used for migrations and seeding
2. Put them in `aznar-api\.env` (copy `.env.example` if it doesn't exist).
3. Create the tables, load demo data, start the API:

```powershell
cd C:\Users\forrosuelo\aznar\aznar-api
npm install
npm run db:migrate          # creates the 13 tables in Supabase (public schema)
npm run seed -- --yes       # DELETES everything, then loads demo data
npm run dev                 # http://localhost:4000
```

Refresh **Database → Tables** in Supabase and you'll see them.

Without `DATABASE_URL`, `npm run dev` runs an **in-process Postgres (PGlite)** with demo data instead — handy
offline, but nothing is saved between restarts.

Then start the two frontends with `VITE_API_MODE=http` and `VITE_API_URL=http://localhost:4000` in their `.env`.

### Supabase security note

Every table has **Row Level Security enabled with no policies**. That blocks Supabase's public Data API
(the `anon`/`authenticated` keys) from reading payroll data. The API connects as the database owner, which
bypasses RLS. Don't add RLS policies unless you intend the frontends to query Supabase directly — they shouldn't.
Never put the database password or service-role key in a frontend.

### Demo accounts

Password for all: `SEED_PASSWORD` in `.env` (default `Aznar@2026`). For local/demo use only.

| Email | App | Role |
|---|---|---|
| `leonard.forrosuelo@aznar.com` (and every other `first.last@aznar.com`) | AZONE | employee |
| `payroll@aznar.com` | APAY (and AZONE as Kristine) | Payroll Admin |
| `hr@aznar.com` | APAY (and AZONE as Ana) | HR |
| `finance@aznar.com` | APAY (and AZONE as Jose) | Finance |
| `management@aznar.com` | APAY (and AZONE as Nicole) | Management |

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with auto-reload (in-memory Postgres if no `DATABASE_URL`) |
| `npm run db:generate` | After editing `src/db/schema.ts`: write a new SQL migration into `drizzle/` |
| `npm run db:migrate` | Apply pending migrations to Supabase (`DIRECT_URL`) |
| `npm run seed -- --yes` | Wipe and re-seed the database with demo data |
| `npm test` | Payroll engine + API integration tests (in-memory Postgres) |
| `npm run typecheck` | TypeScript check |

## How the rules are enforced

- **Login**: bcrypt password hashes, generic error messages, rate-limited (20 tries / 15 min). The role always comes
  from the account — the role APAY's demo picker sends is ignored.
- **Tokens**: JWT signed with `JWT_SECRET`, 8-hour expiry, and bound to one app (`aud: azone` or `aud: apay`).
- **Permissions**: `src/lib/permissions.ts` (same map as the APAY UI). Every APAY write checks one.
- **Maker–checker**: the person who computed a payroll can't approve it.
- **Payroll states**: `draft → computed → review → approved → released`. Approved payroll is locked.
  Compute and release run in **Postgres transactions** with a row lock on the period, so a cut-off is never
  half-updated and two people can't process it at once.
- **Payslips are frozen**: each payroll line stores a snapshot of the employee taken at compute time.
- **Money**: `numeric(12,2)` columns, `decimal.js` math, returned as `"24500.00"` strings.
- **Privacy**: AZONE never returns salary; government IDs and bank accounts are masked.
- **Time zone**: all business dates use Asia/Manila, whatever the server's time zone.
- **On release**: loan balances are reduced, every employee gets a "payslip ready" notification in AZONE, and an audit entry is written.

## Endpoints

```
POST /auth/login                       { email, password, app: 'azone' | 'apay' }

GET   /azone/me                         PATCH /azone/me/contact
GET   /azone/payslips                   GET   /azone/payslips/:id
GET   /azone/attendance/today           POST  /azone/attendance/punch       { kind }
GET   /azone/attendance?month=yyyy-MM   GET   /azone/attendance/summary
GET   /azone/leaves/balances            GET   /azone/leaves                 POST /azone/leaves
GET   /azone/requests                   POST  /azone/requests
GET   /azone/announcements              GET   /azone/announcements/:id
GET   /azone/notifications              POST  /azone/notifications/read     { ids? }
GET   /azone/company

GET   /apay/employees                   GET /apay/employees/:id    POST /apay/employees    PUT /apay/employees/:id
GET   /apay/periods                     GET /apay/periods/:id
GET   /apay/periods/:id/attendance      GET /apay/periods/:id/lines
POST  /apay/periods/:id/compute         POST /apay/periods/:id/status      { status }
GET   /apay/adjustments                 POST /apay/adjustments             PUT /apay/adjustments/:id
GET   /apay/overtime                    POST /apay/overtime/:id/decision   { status }
GET   /apay/leaves                      POST /apay/leaves/:id/decision     { status }
GET   /apay/announcements               POST /apay/announcements           PUT /apay/announcements/:id
GET   /apay/settings                    PUT  /apay/settings
GET   /apay/audit
GET   /health
```

## Deploy on Vercel

1. Push this repo to GitHub and import it in Vercel. `vercel.json` routes every request to `api/index.ts`.
2. Environment variables: `DATABASE_URL` (Transaction pooler, 6543), `JWT_SECRET`,
   `CORS_ORIGINS` (e.g. `https://azone.aznar.com,https://apay.aznar.com`), `NODE_ENV=production`.
3. Run `npm run db:migrate` from your machine whenever the schema changes.
4. In each frontend's Vercel project: `VITE_API_MODE=http`, `VITE_API_URL=https://api.aznar.com`.

A company-use deployment needs Vercel's Pro plan.

## Structure

```
api/index.ts            Vercel entry
drizzle/                SQL migrations (generated from src/db/schema.ts)
src/app.ts              Express app (helmet, CORS, JSON limit, routes, errors)
src/server.ts           Local server (+ in-memory Postgres)
src/config.ts           Validated environment
src/db/                 Drizzle schema, connection, migrate script
src/routes/             auth, azone, apay
src/services/           payroll (compute/approve/release), attendance, notifications, audit, serializers
src/lib/                payroll engine, dates (Asia/Manila), permissions, money
src/seed/               Demo data
tests/                  Vitest + Supertest
```
