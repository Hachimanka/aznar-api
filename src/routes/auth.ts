import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { rateLimit } from 'express-rate-limit'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { employees, users } from '../db/schema.js'
import { HttpError, forbidden, handler, parse } from '../lib/http.js'
import { roleLabels, staffRoles, type StaffRole } from '../lib/permissions.js'
import { signToken } from '../middleware/auth.js'
import { getAvatar } from '../services/core.js'
import { azoneEmployee } from '../services/serializers.js'

export const authRouter = Router()

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
  skip: () => process.env.NODE_ENV === 'test',
})

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
  app: z.enum(['azone', 'apay']),
  // Older APAY builds sent a demo role; the API ignores it — the role always comes from the account
  role: z.string().optional(),
})

// Compared against when the email doesn't exist, so response time doesn't reveal valid accounts
const DUMMY_HASH = bcrypt.hashSync('not-a-real-account', 10)

authRouter.post(
  '/login',
  loginLimiter,
  handler(async (req) => {
    const { email, password, app } = parse(loginSchema, req.body)
    const [user] = await db()
      .select()
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), eq(users.active, true)))
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password')

    const touch = () => db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))

    if (app === 'apay') {
      if (!staffRoles.includes(user.role as StaffRole)) throw forbidden('APAY is for the HR department only')
      await touch()
      return {
        token: signToken({ userId: user.id, name: user.name, role: user.role, employeeId: user.employeeId ?? undefined, app }),
        user: { id: user.id, name: user.name, email: user.email, role: user.role, title: user.title || roleLabels[user.role as StaffRole] },
      }
    }

    // AZONE: any account linked to an employee record
    const [employee] = user.employeeId ? await db().select().from(employees).where(eq(employees.id, user.employeeId)) : []
    if (!employee || employee.status === 'resigned') throw forbidden('Your account is not linked to an active employee record')
    await touch()
    return {
      token: signToken({ userId: user.id, name: user.name, role: user.role, employeeId: employee.id, app }),
      employee: azoneEmployee(employee, await getAvatar(employee.id)),
    }
  }),
)
