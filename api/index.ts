import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { connectDb } from '../src/db.js'

/** Vercel serverless entry point. vercel.json rewrites every path here. */
const app = createApp()

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!config.MONGODB_URI) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ message: 'MONGODB_URI is not configured' }))
    return
  }
  await connectDb(config.MONGODB_URI)
  app(req as never, res as never)
}
