import { Router, type Request } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Adjustment, Announcement, Audit, Employee, Leave, Overtime, PayrollLine, PayrollPeriod } from '../models/index.js'
import { forbidden, handler, isoDay, notFound, objectId, parse, pesoString } from '../lib/http.js'
import { D128 } from '../lib/money.js'
import { staffRoles } from '../lib/permissions.js'
import { auth, requireAny, requireAuth, requirePermission } from '../middleware/auth.js'
import { periodAttendance } from '../services/attendance.js'
import { audit, getPayrollSettings, notify, saveSetting } from '../services/core.js'
import { computePeriod, ensureCurrentPeriod, transitionPeriod } from '../services/payroll.js'
import { apayAdjustment, apayAnnouncement, apayAudit, apayEmployee, apayLeave, apayLine, apayOvertime, apayPeriod } from '../services/serializers.js'

/** HR / payroll operations. Staff accounts only; each write checks a permission. */
export const apayRouter = Router()
apayRouter.use(requireAuth('apay'), (req, _res, next) => (staffRoles.includes(auth(req).role as never) ? next() : next(forbidden())))

async function employeeIndex(ids?: unknown[]) {
  const list = await Employee.find(ids ? { _id: { $in: ids } } : {})
    .select('firstName lastName department')
    .lean()
  return new Map(list.map((e) => [String(e._id), e]))
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

apayRouter.get(
  '/employees',
  handler(async () => (await Employee.find().sort({ lastName: 1 }).lean()).map(apayEmployee)),
)

apayRouter.get(
  '/employees/:id',
  handler(async (req) => {
    const e = await Employee.findById(objectId(req.params.id, 'Employee')).lean()
    if (!e) throw notFound('Employee')
    return apayEmployee(e)
  }),
)

/** Masked values coming back from the UI (e.g. "•••• 1234") must not overwrite the real ones. */
function withoutMasked<T extends Record<string, string>>(obj: T | undefined) {
  return obj ? Object.fromEntries(Object.entries(obj).filter(([, v]) => !v.includes('•') && v !== '—')) : undefined
}

function employeeUpdate(input: z.infer<typeof employeeSchema>) {
  const { bank, govIds, monthlyBasic, ...rest } = input
  const set: Record<string, unknown> = { ...rest, monthlyBasic: D128(monthlyBasic) }
  for (const [k, v] of Object.entries(withoutMasked(bank) ?? {})) set[`bank.${k}`] = v
  for (const [k, v] of Object.entries(withoutMasked(govIds) ?? {})) set[`govIds.${k}`] = v
  return set
}

apayRouter.post(
  '/employees',
  requirePermission('employees.manage'),
  handler(async (req, res) => {
    const input = parse(employeeSchema, req.body)
    const e = new Employee()
    e.set(employeeUpdate(input))
    await e.save()
    await audit(req, 'Added employee', `${input.firstName} ${input.lastName}`)
    res.status(201)
    return apayEmployee(e.toObject())
  }),
)

apayRouter.put(
  '/employees/:id',
  requirePermission('employees.manage'),
  handler(async (req) => {
    const input = parse(employeeSchema, req.body)
    const e = await Employee.findByIdAndUpdate(
      objectId(req.params.id, 'Employee'),
      { $set: employeeUpdate(input) },
      { new: true, runValidators: true },
    ).lean()
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
    return (await PayrollPeriod.find().sort({ end: -1 }).limit(48).lean()).map(apayPeriod)
  }),
)

async function findPeriod(req: Request) {
  const p = await PayrollPeriod.findById(objectId(req.params.id, 'Payroll period')).lean()
  if (!p) throw notFound('Payroll period')
  return p
}

apayRouter.get(
  '/periods/:id',
  handler(async (req) => apayPeriod(await findPeriod(req))),
)

apayRouter.get(
  '/periods/:id/attendance',
  handler(async (req) => {
    const p = await findPeriod(req)
    const employees = await Employee.find({ status: { $ne: 'resigned' }, hireDate: { $lte: p.end } })
      .sort({ lastName: 1 })
      .lean()
    const summary = await periodAttendance(
      employees.map((e) => e._id),
      p.start,
      p.end,
    )
    return employees.map((e) => {
      const s = summary.get(String(e._id))!
      return {
        employeeId: String(e._id),
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
      }
    })
  }),
)

apayRouter.get(
  '/periods/:id/lines',
  handler(async (req) => {
    const p = await findPeriod(req)
    return (await PayrollLine.find({ periodId: p._id }).sort({ name: 1 }).lean()).map(apayLine)
  }),
)

apayRouter.post(
  '/periods/:id/compute',
  requirePermission('payroll.process'),
  handler(async (req) => {
    const id = objectId(req.params.id, 'Payroll period')
    const session = await mongoose.startSession()
    try {
      // Replacing every line of a cut-off happens all-or-nothing
      await session.withTransaction(async () => {
        const p = await computePeriod(id, { userId: auth(req).userId }, session)
        await audit(req, 'Computed payroll', p.label, session)
      })
    } finally {
      await session.endSession()
    }
    return apayPeriod((await PayrollPeriod.findById(id).lean())!)
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
    const id = objectId(req.params.id, 'Payroll period')
    const a = auth(req)
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        const p = await transitionPeriod(id, status, { userId: a.userId, name: a.name, role: a.role }, session)
        await audit(req, actionLabels[status], p.label, session)
      })
    } finally {
      await session.endSession()
    }
    return apayPeriod((await PayrollPeriod.findById(id).lean())!)
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
    const list = await Adjustment.find().sort({ createdAt: -1 }).lean()
    const names = new Map([...(await employeeIndex())].map(([id, e]) => [id, `${e.firstName} ${e.lastName}`]))
    return list.map((a) => apayAdjustment(a, names))
  }),
)

async function saveAdjustment(req: Request, id?: string) {
  const input = parse(adjustmentSchema, req.body)
  const emp = await Employee.findById(objectId(input.employeeId, 'Employee')).lean()
  if (!emp) throw notFound('Employee')
  const set = { ...input, amount: D128(input.amount), balance: input.balance ? D128(input.balance) : undefined }
  const doc = id ? await Adjustment.findByIdAndUpdate(id, { $set: set }, { new: true }).lean() : (await Adjustment.create(set)).toObject()
  if (!doc) throw notFound('Adjustment')
  await audit(req, id ? `Updated ${input.kind}` : `Added ${input.kind}`, `${input.name} · ${emp.firstName} ${emp.lastName}`)
  return apayAdjustment(doc, new Map([[String(emp._id), `${emp.firstName} ${emp.lastName}`]]))
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
  handler((req) => saveAdjustment(req, objectId(req.params.id, 'Adjustment'))),
)

/* ---------------------------------- Overtime ---------------------------------- */

apayRouter.get(
  '/overtime',
  handler(async () => {
    const list = await Overtime.find().sort({ date: -1 }).limit(200).lean()
    const emps = await employeeIndex(list.map((o) => o.employeeId))
    return list.map((o) => apayOvertime(o, emps.get(String(o.employeeId))))
  }),
)

const decisionSchema = z.object({ status: z.enum(['approved', 'rejected']) })

apayRouter.post(
  '/overtime/:id/decision',
  requirePermission('overtime.decide'),
  handler(async (req) => {
    const { status } = parse(decisionSchema, req.body)
    const o = await Overtime.findOneAndUpdate(
      { _id: objectId(req.params.id, 'Overtime request'), status: 'pending' },
      { $set: { status, decidedBy: auth(req).name } },
      { new: true },
    ).lean()
    if (!o) throw notFound('Pending overtime request')
    const emp = (await employeeIndex([o.employeeId])).get(String(o.employeeId))
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
    const list = await Leave.find().sort({ start: -1 }).limit(300).lean()
    const emps = await employeeIndex(list.map((l) => l.employeeId))
    return list.map((l) => apayLeave(l, emps.get(String(l.employeeId))))
  }),
)

apayRouter.post(
  '/leaves/:id/decision',
  requirePermission('attendance.manage'),
  handler(async (req) => {
    const { status } = parse(decisionSchema, req.body)
    const l = await Leave.findOneAndUpdate(
      { _id: objectId(req.params.id, 'Leave'), status: 'pending' },
      { $set: { status, decidedBy: auth(req).name } },
      { new: true },
    ).lean()
    if (!l) throw notFound('Pending leave')
    await notify([l.employeeId], {
      kind: 'leave',
      title: `Leave ${status}`,
      body: `Your ${l.days}-day ${l.type} leave was ${status}.`,
      link: '/app/leaves',
    })
    const emp = (await employeeIndex([l.employeeId])).get(String(l.employeeId))
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
  handler(async () => (await Announcement.find().sort({ publishedAt: -1 }).limit(100).lean()).map(apayAnnouncement)),
)

async function saveAnnouncement(req: Request, id?: string) {
  const input = parse(announcementSchema, req.body)
  const existing = id ? await Announcement.findById(id) : null
  if (id && !existing) throw notFound('Announcement')
  const wasPublished = existing?.status === 'published'
  const doc = existing ?? new Announcement({ author: auth(req).name })
  doc.set(input)
  if (input.status === 'published' && !wasPublished) doc.publishedAt = new Date()
  await doc.save()

  if (input.status === 'published' && !wasPublished) {
    const audience = await Employee.find(
      input.audience === 'all' ? { status: { $ne: 'resigned' } } : { department: input.audience, status: { $ne: 'resigned' } },
    )
      .select('_id')
      .lean()
    await notify(
      audience.map((e) => e._id),
      { kind: 'announcement', title: `New announcement: ${input.category}`, body: input.title, link: `/app/announcements/${doc._id}` },
    )
  }
  await audit(req, input.status === 'published' ? 'Published announcement' : 'Saved announcement draft', input.title)
  return apayAnnouncement(doc.toObject())
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
  handler((req) => saveAnnouncement(req, objectId(req.params.id, 'Announcement'))),
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
  handler(async () => (await Audit.find().sort({ createdAt: -1 }).limit(100).lean()).map(apayAudit)),
)
