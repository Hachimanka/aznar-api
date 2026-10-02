import { config } from '../config.js'
import { connectDb, disconnectDb } from '../db/index.js'
import { seedDatabase } from './seed.js'

/** `npm run seed` — wipes and re-seeds the Supabase database. Never run against real payroll data. */
const url = process.env.DIRECT_URL ?? config.DATABASE_URL
if (!url) {
  console.error('Set DATABASE_URL (or DIRECT_URL) first. `npm run dev` without it already seeds an in-memory database.')
  process.exit(1)
}
if (!process.argv.includes('--yes')) {
  console.error('This DELETES all data in the database and loads demo data. Re-run with: npm run seed -- --yes')
  process.exit(1)
}

connectDb(url)
const result = await seedDatabase({ password: config.SEED_PASSWORD })
console.log('Seeded:', result)
await disconnectDb()
