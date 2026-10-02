import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config.js'
import { authRouter } from './routes/auth.js'
import { azoneRouter } from './routes/azone.js'
import { apayRouter } from './routes/apay.js'
import { errorHandler, notFoundHandler } from './middleware/errors.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1) // behind Vercel's proxy — needed for correct client IPs in rate limiting

  app.use(helmet())
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  )
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'aznar-api' })
  })
  app.use('/auth', authRouter)
  app.use('/azone', azoneRouter)
  app.use('/apay', apayRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
