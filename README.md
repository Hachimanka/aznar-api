# aznar-api — shared backend for AZONE and APAY

Express 5 + TypeScript + MongoDB (Mongoose). One API, two route groups:

| Prefix   | Used by | Who can call it |
|----------|---------|-----------------|
| `/auth`  | both    | anyone (login) |
| `/azone` | AZONE (employee app) | any account linked to an employee — only their own data |
| `/apay`  | APAY (payroll app)   | staff roles only: `payroll_admin`, `hr`, `finance`, `management` |

The payroll engine (`src/lib/payroll.ts`) runs **here**. APAY only displays results.

## Run locally (PowerShell)

```powershell
cd C:\Users\forrosuelo\aznar\aznar-api
copy .env.example .env    # then set JWT_SECRET to a long random string
npm install
npm run dev               # http://localhost:4000
```

With `MONGODB_URI` empty, `npm run dev` starts an **in-memory MongoDB** (a single-node replica set, so transactions
work) and fills it with demo data on every start. Nothing is saved between restarts. To keep data, point
`MONGODB_URI` at MongoDB Atlas (or a local replica set) and run `npm run seed` once.

Then start the two frontends with `VITE_API_MODE=http` and `VITE_API_URL=http://localhost:4000` in their `.env`.

### Demo accounts

Password for all: the `SEED_PASSWORD` in `.env` (default `Aznar@2026`).

| Email | App | Role |
|---|---|---|
| `leonard.forrosuelo@aznar.com` (and every other `first.last@aznar.com`) | AZONE | employee |
| `payroll@aznar.com` | APAY (and AZONE as Kristine) | Payroll Admin |
| `hr@aznar.com` | APAY (and AZONE as Ana) | HR |
| `finance@aznar.com` | APAY (and AZONE as Jose) | Finance |
| `management@aznar.com` | APAY (and AZONE as Nicole) | Management |

These are demo credentials for local development only. Change or remove them before real use.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with auto-reload (in-memory DB if no `MONGODB_URI`) |
| `npm run seed` | Wipe and re-seed the database in `MONGODB_URI` (refuses in production) |
| `npm test` | Payroll engine + API integration tests (in-memory MongoDB) |
| `npm run typecheck` | TypeScript check |

## How the rules are enforced

- **Login**: bcrypt password hashes, generic error messages, rate-limited (20 tries / 15 min). The role always comes
  from the account — the role APAY's demo picker sends is ignored.
- **Tokens**: JWT signed with `JWT_SECRET`, 8-hour expiry, and bound to one app (`aud: azone` or `aud: apay`).
  An AZONE token is rejected on APAY routes.
- **Permissions**: `src/lib/permissions.ts` (same map as the APAY UI). Every APAY write checks one.
- **Maker–checker**: the person who computed a payroll can't approve it.
- **Payroll states**: `draft → computed → review → approved → released`. Approved payroll is locked.
  Compute and release run in **MongoDB transactions**, so a cut-off is never half-updated.
- **Payslips are frozen**: each payroll line stores a snapshot of the employee (name, department, salary) taken at compute time.
- **Money**: stored as `Decimal128`, calculated with `decimal.js`, returned as `"24500.00"` strings.
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

## Deploy (Vercel + MongoDB Atlas)

1. Create an Atlas cluster (it's a replica set by default, so transactions work). Add a database user and allow
   Vercel's IPs (or `0.0.0.0/0` with a strong password).
2. Push this repo to GitHub and import it in Vercel. `vercel.json` routes every request to `api/index.ts`.
3. Set environment variables in Vercel: `MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGINS`
   (e.g. `https://azone.aznar.com,https://apay.aznar.com`), `NODE_ENV=production`.
4. Seed once from your machine against Atlas: `MONGODB_URI=... npm run seed` (only for a demo database).
5. In each frontend's Vercel project set `VITE_API_MODE=http` and `VITE_API_URL=https://api.aznar.com`.

The serverless entry reuses one MongoDB connection across warm invocations (`src/db.ts`).
A company-use deployment needs Vercel's Pro plan.

## Structure

```
api/index.ts            Vercel entry
src/app.ts              Express app (helmet, CORS, JSON limit, routes, errors)
src/server.ts           Local server (+ in-memory MongoDB)
src/config.ts           Validated environment
src/models/             Mongoose schemas
src/routes/             auth, azone, apay
src/services/           payroll (compute/approve/release), attendance, notifications, audit, serializers
src/lib/                payroll engine, dates (Asia/Manila), permissions, money
src/seed/               Demo data
tests/                  Vitest + Supertest
```
