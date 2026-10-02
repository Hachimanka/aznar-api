import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.js'

export type Db = PostgresJsDatabase<typeof schema>
/** A database or an open transaction — services accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Exec = Db | Tx

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * Serverless functions start and stop often. Keep one client on the global object so warm
 * invocations reuse it instead of opening new connections each time.
 */
type State = { db: Db | null; close: (() => Promise<void>) | null }
const g = globalThis as typeof globalThis & { __aznarDb?: State }
const state: State = (g.__aznarDb ??= { db: null, close: null })

export function db(): Db {
  if (!state.db) throw new Error('Database not connected')
  return state.db
}

/**
 * Connect to Supabase Postgres. Use the pooler URL (port 6543, "Transaction" mode) for the API on Vercel.
 * Prepared statements are disabled because the transaction pooler doesn't support them.
 */
export function connectDb(url: string) {
  if (state.db) return state.db
  const client = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 })
  state.db = drizzle(client, { schema })
  state.close = () => client.end({ timeout: 5 })
  return state.db
}

/** In-process Postgres (PGlite) for local dev and tests — no Supabase needed. Runs migrations. */
export async function connectMemoryDb() {
  const [{ PGlite }, { drizzle: drizzlePglite }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ])
  const client = new PGlite()
  const memDb = drizzlePglite(client, { schema })
  await migrate(memDb, { migrationsFolder })
  // Same query API as the postgres-js driver
  state.db = memDb as unknown as Db
  state.close = () => client.close()
  return state.db
}

export async function disconnectDb() {
  await state.close?.()
  state.db = null
  state.close = null
}

export { schema }
