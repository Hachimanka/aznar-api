import { config } from '../config.js'
import { connectDb, disconnectDb } from '../db.js'
import { seedDatabase } from './seed.js'

/** `npm run seed` — wipes and re-seeds the database in MONGODB_URI. Never run against production data. */
if (!config.MONGODB_URI) {
  console.error('Set MONGODB_URI first. (`npm run dev` without it already seeds an in-memory database.)')
  process.exit(1)
}
if (config.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error('Refusing to seed with NODE_ENV=production. Pass --force if you are sure.')
  process.exit(1)
}

await connectDb(config.MONGODB_URI)
const result = await seedDatabase({ password: config.SEED_PASSWORD })
console.log('Seeded:', result)
await disconnectDb()
