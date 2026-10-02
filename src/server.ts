import { config } from './config.js'
import { connectDb, connectMemoryDb } from './db/index.js'
import { createApp } from './app.js'
import { seedDatabase } from './seed/seed.js'

/** Local server. Without DATABASE_URL it runs an in-process Postgres (PGlite) with demo data. */
async function main() {
  if (config.DATABASE_URL) {
    connectDb(config.DATABASE_URL)
    console.log('Using Supabase Postgres (DATABASE_URL)')
  } else {
    await connectMemoryDb()
    const seeded = await seedDatabase({ password: config.SEED_PASSWORD })
    console.log('In-memory Postgres ready with demo data:', seeded)
    console.log(`Demo password for every account: ${config.SEED_PASSWORD}`)
  }

  createApp().listen(config.PORT, () => console.log(`aznar-api listening on http://localhost:${config.PORT}`))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
