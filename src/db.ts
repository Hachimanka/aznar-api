import mongoose from 'mongoose'

/**
 * Serverless functions (Vercel) start and stop often. Cache the connection on the
 * global object so warm invocations reuse it instead of opening a new pool each time.
 */
type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null }
const g = globalThis as typeof globalThis & { __mongoose?: Cache }
const cache: Cache = (g.__mongoose ??= { conn: null, promise: null })

export async function connectDb(uri: string) {
  if (cache.conn) return cache.conn
  cache.promise ??= mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  })
  try {
    cache.conn = await cache.promise
  } catch (err) {
    cache.promise = null
    throw err
  }
  return cache.conn
}

export async function disconnectDb() {
  await mongoose.disconnect()
  cache.conn = null
  cache.promise = null
}
