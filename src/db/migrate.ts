import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { migrationsFolder } from './index.js'

/** `npm run db:migrate` — create/upgrade tables in Supabase. */
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('Set DIRECT_URL (Supabase session/direct connection string) or DATABASE_URL in .env')
  process.exit(1)
}
const client = postgres(url, { max: 1 })
await migrate(drizzle(client), { migrationsFolder })
console.log('Migrations applied')
await client.end()
