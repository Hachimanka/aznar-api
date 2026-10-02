import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  PORT: z.coerce.number().default(4000),
  SEED_PASSWORD: z.string().min(8).default('Aznar@2026'),
})

const parsed = schema.safeParse({
  ...process.env,
  // Tests and local in-memory dev may run without a .env file
  JWT_SECRET: process.env.JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'dev-only-secret-not-for-production-use-0000'),
})

if (!parsed.success) {
  console.error('Invalid environment configuration:', z.prettifyError(parsed.error))
  throw new Error('Invalid environment configuration')
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
}
