import { Router, type Request } from 'express'
import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, type Exec } from '../db/index.js'
import { adjustments, announcements, attendanceOverrides, auditLog, employees, leaves, overtime, payrollLines, payrollPeriods } from '../db/schema.js'
import { badRequest, forbidden, handler, isoDay, notFound, parse, pesoString, uuid } from '../lib/http.js'
import { staffRoles, type StaffRole } from '../lib/permissions.js'
import { auth, requireAny, requireAuth, requirePermission } from '../middleware/auth.js'
import { cutoffAttendance } from '../services/attendance.js'
import { audit, getPayrollSettings, notify, saveSetting } from '../services/core.js'
import { computePeriod, ensureCurrentPeriod, reopenForAttendance, transitionPeriod } from '../services/payroll.js'
import { apayAdjustment, apayAnnouncement, apayAudit, apayEmployee, apayLeave, apayLine, apayOvertime, apayPeriod } from '../services/serializers.js'

/** HR / payroll operations. Staff accounts only; each write checks a permission. */
export const apayRouter = Router()
apayRouter.use(requireAuth('apay'), (req, _res, next) => (staffRoles.includes(auth(req).role as StaffRole) ? next() : next(forbidden())))

async function employeeIndex(ids?: string[]) {
  if (ids && !ids.length) return new Map()
  const list = await db()
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, department: employees.department })
    .from(employees)
    .where(ids ? inArray(employees.id, [...new Set(ids)]) : undefined)
  return new Map(list.map((e) => [e.id, e]))
}

/* --------------------------------- Employees --------------------------------- */

const employeeSchema = z.object({
  employeeNo: z.string().trim().min(3).max(30),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.email(),
  position: z.string().trim().min(2).max(100),
  department: z.string().trim().min(2).max(100),
  employmentType: z.enum(['Regular', 'Probationary', 'Contractual']),
  status: z.enum(['active', 'on_leave', 'resigned']),
  monthlyBasic: pesoString,
  hireDate: isoDay,
  taxStatus: z.enum(['S', 'ME', 'S1', 'ME1', 'ME2']),
  bank: z.object({ name: z.string().max(60), account: z.string().max(40) }).optional(),
  govIds: z.object({ sss: z.string().max(30), philhealth: z.string().max(30), pagibig: z.string().max(30), tin: z.string().max(30) }).optional(),
})

/** Masked values coming back from the UI (e.g. "••••1234") must never overwrite the real ones. */
const real = (v: string | undefined) => (v && !v.includes('•') && v !== '—' ? v : undefined)

function employeeValues(input: z.infer<typeof employeeSchema>) {
  const { bank, govIds, email, ...rest } = input
  const values = {
    ...rest,
    email: email.toLowerCase(),
    bankName: real(bank?.name),
    bankAccount: real(bank?.account),
    sss: real(govIds?.sss),
    philhealth: real(govIds?.philhealth),
    pagibig: real(govIds?.pagibig),
    tin: real(govIds?.tin),
  }
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as typeof rest & { email: string }
}

apayRouter.get(
  '/employees',
  handler(async () => (await db().select().from(employees).orderBy(asc(employees.lastName))).map(apayEmployee)),
)

apayRouter.get(
  '/employees/:id',
  handler(async (req) => {
    const [e] = await db()
      .select()
      .from(employees)
      .where(eq(employees.id, uuid(req.params.id, 'Employee')))
    if (!e) throw notFound('Employee')
    return apayEmployee(e)
  }),
)

apayRouter.post(
  '/employees',
  requirePermission('employees.manage'),
  handler(async (req, res) => {
    const input = parse(employeeSchema, req.body)
    const [e] = await db().insert(employees).values(employeeValues(input)).returning()
    await audit(req, 'Added employee', `${e.firstName} ${e.lastName}`)
    res.status(201)
    return apayEmployee(e)
  }),
)

apayRouter.put(
  '/employees/:id',
  requirePermission('employees.manage'),
  handler(async (req) => {
    const input = parse(employeeSchema, req.body)
    const [e] = await db()
      .update(employees)
      .set(employeeValues(input))
      .where(eq(employees.id, uuid(req.params.id, 'Employee')))
      .returning()
    if (!e) throw notFound('Employee')
    await audit(req, 'Updated employee', `${e.firstName} ${e.lastName}`)
    return apayEmployee(e)
  }),
)

/* ---------------------------------- Periods ---------------------------------- */

apayRouter.get(
  '/periods',
  handler(async () => {
    await ensureCurrentPeriod()
    return (await db().select().from(payrollPeriods).orderBy(desc(payrollPeriods.endDate)).limit(48)).map(apayPeriod)
  }),
)

async function findPeriod(req: Request) {
  const [p] = await db()
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, uuid(req.params.id, 'Payroll period')))
  if (!p) throw notFound('Payroll period')
  return p
}

apayRouter.get(
  '/periods/:id',
  handler(async (req) => apayPeriod(await findPeriod(req))),
)

async function attendanceRows(p: typeof payrollPeriods.$inferSelect, q: Exec = db()) {
  const staff = await q
    .select()
    .from(employees)
    .where(and(ne(employees.status, 'resigned'), lte(employees.hireDate, p.endDate)))
    .orderBy(asc(employees.lastName))
  const summary = await cutoffAttendance(
    p,
    staff.map((e) => e.id),
    q,
  )
  return staff.map((e) => {
    const s = summary.get(e.id)!
    return {
      employeeId: e.id,
      employeeNo: e.employeeNo,
      name: `${e.firstName} ${e.lastName}`,
      department: e.department,
      workingDays: s.workingDays,
      daysPresent: s.daysPresent,
      absentDays: s.absentDays,
      lateMinutes: s.lateMinutes,
      overtimeHours: s.overtimeHours,
      paidLeaveDays: s.paidLeaveDays,
      unpaidLeaveDays: s.unpaidLeaveDays,
      source: s.source,
    }
  })
}

apayRouter.get(
  '/periods/:id/attendance',
  handler(async (req) => attendanceRows(await findPeriod(req))),
)

const halfDays = z.number().min(0).max(31).multipleOf(0.5, 'Use whole or half days')
const attendanceSchema = z.object({
  source: z.enum(['manual', 'upload']),
  rows: z
    .array(
      z.object({
        employeeId: z.string(),
        daysPresent: halfDays,
        absentDays: halfDays,
        lateMinutes: z.number().int().min(0).max(10_000),
        paidLeaveDays: halfDays,
        unpaidLeaveDays: halfDays,
      }),
    )
    .min(1)
    .max(2000),
})

/** HR edits one row or uploads a whole cut-off; these replace the DTR summary for those employees. */
apayRouter.put(
  '/periods/:id/attendance',
  requirePermission('attendance.manage'),
  handler(async (req) => {
    const { source, rows } = parse(attendanceSchema, req.body)
    const id = uuid(req.params.id, 'Payroll period')
    const a = auth(req)
    return db().transaction(async (tx) => {
      const p = await reopenForAttendance(id, tx)
      const current = new Map((await attendanceRows(p, tx)).map((r) => [r.employeeId, r]))
      const problems: string[] = []
      for (const r of rows) {
        const cur = current.get(r.employeeId)
        if (!cur) problems.push(`Unknown or inactive employee (${r.employeeId})`)
        else if (r.daysPresent + r.absentDays + r.paidLeaveDays + r.unpaidLeaveDays !== cur.workingDays)
          problems.push(`${cur.name}: present + absent + leave must equal ${cur.workingDays} working days`)
      }
      if (problems.length) throw badRequest(problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (+${problems.length - 5} more)` : ''))

      await tx
        .insert(attendanceOverrides)
        .values(rows.map((r) => ({ ...r, periodId: p.id, source, updatedById: a.userId })))
        .onConflictDoUpdate({
          target: [attendanceOverrides.periodId, attendanceOverrides.employeeId],
          set: {
            daysPresent: sql`excluded.days_present`,
            absentDays: sql`excluded.absent_days`,
            lateMinutes: sql`excluded.late_minutes`,
            paidLeaveDays: sql`excluded.paid_leave_days`,
            unpaidLeaveDays: sql`excluded.unpaid_leave_days`,
            source: sql`excluded.source`,
            updatedById: sql`excluded.updated_by_id`,
            updatedAt: new Date(),
          },
        })
      const target = source === 'upload' ? `${p.label} · ${rows.length} employees` : `${p.label} · ${current.get(rows[0].employeeId)!.name}`
      await audit(req, source === 'upload' ? 'Uploaded attendance' : 'Edited attendance', target, tx)
      return attendanceRows(p, tx)
    })
  }),
)

/** Drop HR's override so the employee's cut-off goes back to the DTR-derived numbers. */
apayRouter.delete(
  '/periods/:id/attendance/:employeeId',
  requirePermission('attendance.manage'),
  handler(async (req) => {
    const id = uuid(req.params.id, 'Payroll period')
    const employeeId = uuid(req.params.employeeId, 'Employee')
    return db().transaction(async (tx) => {
      const p = await reopenForAttendance(id, tx)
      const [gone] = await tx
        .delete(attendanceOverrides)
        .where(and(eq(attendanceOverrides.periodId, p.id), eq(attendanceOverrides.employeeId, employeeId)))
        .returning()
      if (!gone) throw notFound('Attendance override')
      const rows = await attendanceRows(p, tx)
      await audit(req, 'Reset attendance to DTR', `${p.label} · ${rows.find((r) => r.employeeId === employeeId)?.name ?? ''}`, tx)
      return rows
    })
  }),
)

apayRouter.get(
  '/periods/:id/lines',
  handler(async (req) => {
    const p = await findPeriod(req)
    return (await db().select().from(payrollLines).where(eq(payrollLines.periodId, p.id)).orderBy(asc(payrollLines.name))).map(apayLine)
  }),
)

apayRouter.post(
  '/periods/:id/compute',
  requirePermission('payroll.process'),
  handler(async (req) => {
    const id = uuid(req.params.id, 'Payroll period')
    // Replacing every line of a cut-off happens all-or-nothing
    const period = await db().transaction(async (tx) => {
      const p = await computePeriod(id, { userId: auth(req).userId }, tx)
      await audit(req, 'Computed payroll', p.label, tx)
      return p
    })
    return apayPeriod(period)
  }),
)

const actionLabels = {
  review: 'Submitted payroll for review',
  computed: 'Returned payroll for changes',
  approved: 'Approved payroll',
  released: 'Released payroll',
} as const

apayRouter.post(
  '/periods/:id/status',
  requireAny('payroll.process', 'payroll.approve', 'payroll.release'),
  handler(async (req) => {
    const { status } = parse(z.object({ status: z.enum(['computed', 'review', 'approved', 'released']) }), req.body)
    const id = uuid(req.params.id, 'Payroll period')
    const a = auth(req)
    const period = await db().transaction(async (tx) => {
      const p = await transitionPeriod(id, status, { userId: a.userId, name: a.name, role: a.role }, tx)
      await audit(req, actionLabels[status], p.label, tx)
      return p
    })
    return apayPeriod(period)
  }),
)

/* ------------------------- Allowances & deductions ------------------------- */

const adjustmentSchema = z
  .object({
    employeeId: z.string(),
    kind: z.enum(['allowance', 'deduction']),
    category: z.enum(['de_minimis', 'taxable', 'loan', 'other']),
    name: z.string().trim().min(2).max(80),
    amount: pesoString,
    balance: pesoString.optional(),
    active: z.boolean().default(true),
  })
  .refine((v) => (v.kind === 'allowance' ? ['de_minimis', 'taxable'] : ['loan', 'other']).includes(v.category), {
    message: 'Category does not match kind',
    path: ['category'],
  })

apayRouter.get(
  '/adjustments',
  handler(async () => {
    const list = await db().select().from(adjustments).orderBy(desc(adjustments.createdAt))
    const emps = await employeeIndex()
    return list.map((a) => apayAdjustment(a, emps.get(a.employeeId)))
  }),
)

async function saveAdjustment(req: Request, id?: string) {
  const input = parse(adjustmentSchema, req.body)
  const emp = (await employeeIndex([uuid(input.employeeId, 'Employee')])).get(input.employeeId)
  if (!emp) throw notFound('Employee')
  const values = { ...input, balance: input.balance ?? null }
  const [doc] = id
    ? await db().update(adjustments).set(values).where(eq(adjustments.id, id)).returning()
    : await db().insert(adjustments).values(values).returning()
  if (!doc) throw notFound('Adjustment')
  await audit(req, id ? `Updated ${input.kind}` : `Added ${input.kind}`, `${input.name} · ${emp.firstName} ${emp.lastName}`)
  return apayAdjustment(doc, emp)
}

apayRouter.post(
  '/adjustments',
  requirePermission('adjustments.manage'),
  handler(async (req, res) => {
    const out = await saveAdjustment(req)
    res.status(201)
    return out
  }),
)

apayRouter.put(
  '/adjustments/:id',
  requirePermission('adjustments.manage'),
  handler((req) => saveAdjustment(req, uuid(req.params.id, 'Adjustment'))),
)

/* ---------------------------------- Overtime ---------------------------------- */

apayRouter.get(
  '/overtime',
  handler(async () => {
    const list = await db().select().from(overtime).orderBy(desc(overtime.date)).limit(200)
    const emps = await employeeIndex(list.map((o) => o.employeeId))
    return list.map((o) => apayOvertime(o, emps.get(o.employeeId)))
  }),
)

const decisionSchema = z.object({ status: z.enum(['approved', 'rejected']) })

apayRouter.post(
  '/overtime/:id/decision',
  requirePermission('overtime.decide'),
  handler(async (req) => {
    const { status } = parse(decisionSchema, req.body)
    const [o] = await db()
      .update(overtime)
      .set({ status, decidedBy: auth(req).name })
      .where(and(eq(overtime.id, uuid(req.params.id, 'Overtime request')), eq(overtime.status, 'pending')))
      .returning()
    if (!o) throw notFound('Pending overtime request')
    const emp = (await employeeIndex([o.employeeId])).get(o.employeeId)
    await notify([o.employeeId], {
      kind: 'request',
      title: `Overtime ${status}`,
      body: `${o.hours} hours on ${o.date} was ${status} by ${auth(req).name}.`,
      link: '/app/requests',
    })
    await audit(req, status === 'approved' ? 'Approved overtime' : 'Rejected overtime', emp ? `${emp.firstName} ${emp.lastName}` : '')
    return apayOvertime(o, emp)
  }),
)

/* ----------------------------------- Leaves ----------------------------------- */

apayRouter.get(
  '/leaves',
  handler(async () => {
    const list = await db().select().from(leaves).orderBy(desc(leaves.startDate)).limit(300)
    const emps = await employeeIndex(list.map((l) => l.employeeId))
    return list.map((l) => apayLeave(l, emps.get(l.employeeId)))
  }),
)

apayRouter.post(
  '/leaves/:id/decision',
  requirePermission('attendance.manage'),
  handler(async (req) => {
    const { status } = parse(decisionSchema, req.body)
    const [l] = await db()
      .update(leaves)
      .set({ status, decidedBy: auth(req).name })
      .where(and(eq(leaves.id, uuid(req.params.id, 'Leave')), eq(leaves.status, 'pending')))
      .returning()
    if (!l) throw notFound('Pending leave')
    const emp = (await employeeIndex([l.employeeId])).get(l.employeeId)
    await notify([l.employeeId], {
      kind: 'leave',
      title: `Leave ${status}`,
      body: `Your ${l.days}-day ${l.type} leave was ${status}.`,
      link: '/app/leaves',
    })
    await audit(req, status === 'approved' ? 'Approved leave' : 'Rejected leave', emp ? `${emp.firstName} ${emp.lastName}` : '')
    return apayLeave(l, emp)
  }),
)

/* -------------------------------- Announcements -------------------------------- */

const announcementSchema = z.object({
  category: z.enum(['HR', 'General', 'Policy', 'Event']),
  title: z.string().trim().min(4).max(140),
  body: z.string().trim().min(10).max(5000),
  status: z.enum(['published', 'draft']),
  audience: z.string().trim().min(2).max(100),
})

apayRouter.get(
  '/announcements',
  handler(async () => (await db().select().from(announcements).orderBy(desc(announcements.publishedAt)).limit(100)).map(apayAnnouncement)),
)

async function saveAnnouncement(req: Request, id?: string) {
  const input = parse(announcementSchema, req.body)
  const [existing] = id ? await db().select().from(announcements).where(eq(announcements.id, id)) : []
  if (id && !existing) throw notFound('Announcement')
  const publishing = input.status === 'published' && existing?.status !== 'published'
  const values = { ...input, ...(publishing ? { publishedAt: new Date() } : {}) }

  const [doc] = existing
    ? await db().update(announcements).set(values).where(eq(announcements.id, existing.id)).returning()
    : await db()
        .insert(announcements)
        .values({ ...values, author: auth(req).name })
        .returning()

  if (publishing) {
    const audience = await db()
      .select({ id: employees.id })
      .from(employees)
      .where(and(ne(employees.status, 'resigned'), input.audience === 'all' ? undefined : eq(employees.department, input.audience)))
    await notify(
      audience.map((e) => e.id),
      { kind: 'announcement', title: `New announcement: ${input.category}`, body: input.title, link: `/app/announcements/${doc.id}` },
    )
  }
  await audit(req, input.status === 'published' ? 'Published announcement' : 'Saved announcement draft', input.title)
  return apayAnnouncement(doc)
}

apayRouter.post(
  '/announcements',
  requireAny('announcements.manage', 'payroll.process'),
  handler(async (req, res) => {
    const out = await saveAnnouncement(req)
    res.status(201)
    return out
  }),
)

apayRouter.put(
  '/announcements/:id',
  requireAny('announcements.manage', 'payroll.process'),
  handler((req) => saveAnnouncement(req, uuid(req.params.id, 'Announcement'))),
)

/* --------------------------------- Settings --------------------------------- */

const settingsSchema = z.object({
  companyName: z.string().trim().min(2).max(100),
  graceMinutes: z.coerce.number().int().min(0).max(60),
  roundLateTo: z.coerce.number().int().min(1).max(60),
  requireTwoStepApproval: z.boolean(),
  autoPublishToAzone: z.boolean(),
})

apayRouter.get(
  '/settings',
  handler(() => getPayrollSettings()),
)

apayRouter.put(
  '/settings',
  requirePermission('settings.manage'),
  handler(async (req) => {
    // Cut-off schedule and pay frequency are fixed; only these rules are editable
    const input = parse(settingsSchema, req.body)
    const next = { ...(await getPayrollSettings()), ...input }
    await saveSetting('payroll', next)
    await audit(req, 'Updated payroll settings', 'Settings')
    return next
  }),
)

/* ----------------------------------- Audit ----------------------------------- */

apayRouter.get(
  '/audit',
  handler(async () => (await db().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100)).map(apayAudit)),
)
