import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { connectDb } from '../src/db/index.js'

/** Vercel serverless entry point. vercel.json rewrites every path here. */
const app = createApp()

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (!config.DATABASE_URL) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ message: 'DATABASE_URL is not configured' }))
    return
  }
  connectDb(config.DATABASE_URL)
  app(req as never, res as never)
}
