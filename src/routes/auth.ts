import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { Employee, User } from '../models/index.js'
import { HttpError, forbidden, handler, parse } from '../lib/http.js'
import { roleLabels, type StaffRole } from '../lib/permissions.js'
import { signToken } from '../middleware/auth.js'
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
  // APAY's demo role picker sends this; the API ignores it — the role always comes from the account
  role: z.string().optional(),
})

// Compared against when the email doesn't exist, so response time doesn't reveal valid accounts
const DUMMY_HASH = bcrypt.hashSync('not-a-real-account', 10)

authRouter.post(
  '/login',
  loginLimiter,
  handler(async (req) => {
    const { email, password, app } = parse(loginSchema, req.body)
    const user = await User.findOne({ email: email.toLowerCase(), active: true }).select('+passwordHash')
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password')

    if (app === 'apay') {
      if (user.role === 'employee') throw forbidden('APAY is for HR, Payroll, Finance and authorized management only')
      user.lastLoginAt = new Date()
      await user.save()
      const ctx = {
        userId: String(user._id),
        name: user.name,
        role: user.role,
        employeeId: user.employeeId ? String(user.employeeId) : undefined,
        app,
      } as const
      return {
        token: signToken(ctx),
        user: { id: String(user._id), name: user.name, email: user.email, role: user.role, title: user.title || roleLabels[user.role as StaffRole] },
      }
    }

    // AZONE: any account linked to an employee record
    const employee = user.employeeId ? await Employee.findById(user.employeeId).lean() : null
    if (!employee || employee.status === 'resigned') throw forbidden('Your account is not linked to an active employee record')
    user.lastLoginAt = new Date()
    await user.save()
    return {
      token: signToken({ userId: String(user._id), name: user.name, role: user.role, employeeId: String(employee._id), app }),
      employee: azoneEmployee(employee),
    }
  }),
)
