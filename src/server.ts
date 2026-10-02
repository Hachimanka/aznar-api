import { config } from './config.js'
import { connectDb } from './db.js'
import { createApp } from './app.js'
import { seedDatabase } from './seed/seed.js'

/** Local server. Without MONGODB_URI it starts an in-memory MongoDB replica set with demo data. */
async function main() {
  let uri = config.MONGODB_URI
  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server')
    // A replica set is required for transactions (payroll compute and release)
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    uri = replSet.getUri('aznar')
    await connectDb(uri)
    const seeded = await seedDatabase({ password: config.SEED_PASSWORD })
    console.log('In-memory MongoDB ready with demo data:', seeded)
    console.log(`Demo password for every account: ${config.SEED_PASSWORD}`)
    const stop = async () => {
      await replSet.stop()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } else {
    await connectDb(uri)
    console.log('Connected to MongoDB')
  }

  createApp().listen(config.PORT, () => console.log(`aznar-api listening on http://localhost:${config.PORT}`))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
