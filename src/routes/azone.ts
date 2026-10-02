import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Announcement, Attendance, Employee, EmployeeRequest, Leave, Notification, PayrollLine, PayrollPeriod } from '../models/index.js'
import { badRequest, conflict, handler, isoDay, notFound, objectId, parse } from '../lib/http.js'
import { eachDay, isWeekend, lastDayOfMonth, manilaDate } from '../lib/dates.js'
import { employeeIdOf, requireAuth } from '../middleware/auth.js'
import { employeeDays } from '../services/attendance.js'
import { getHolidays, getSetting, type CompanyInfo } from '../services/core.js'
import { azoneAnnouncement, azoneDay, azoneEmployee, azoneLeave, azoneNotification, azonePayslip, azoneRequest } from '../services/serializers.js'

/** Employee self-service. Every route acts only on the signed-in employee's own data. */
export const azoneRouter = Router()
azoneRouter.use(requireAuth('azone'))

/* --------------------------------- Profile --------------------------------- */

azoneRouter.get(
  '/me',
  handler(async (req) => {
    const e = await Employee.findById(employeeIdOf(req)).lean()
    if (!e) throw notFound('Employee')
    return azoneEmployee(e)
  }),
)

const contactSchema = z.object({
  phone: z.string().trim().min(7).max(30),
  address: z.string().trim().min(5).max(300),
  emergencyContact: z.object({
    name: z.string().trim().min(2).max(100),
    relation: z.string().trim().min(2).max(50),
    phone: z.string().trim().min(7).max(30),
  }),
})

azoneRouter.patch(
  '/me/contact',
  handler(async (req) => {
    const input = parse(contactSchema, req.body)
    const e = await Employee.findByIdAndUpdate(employeeIdOf(req), { $set: input }, { new: true }).lean()
    if (!e) throw notFound('Employee')
    return azoneEmployee(e)
  }),
)

/* --------------------------------- Payslips --------------------------------- */

azoneRouter.get(
  '/payslips',
  handler(async (req) => {
    const released = await PayrollPeriod.find({ status: 'released' }).sort({ end: -1 }).lean()
    const lines = await PayrollLine.find({ employeeId: employeeIdOf(req), periodId: { $in: released.map((p) => p._id) } }).lean()
    return released.flatMap((p) => {
      const line = lines.find((l) => l.periodId.equals(p._id))
      return line ? [azonePayslip(line, p)] : []
    })
  }),
)

azoneRouter.get(
  '/payslips/:id',
  handler(async (req) => {
    const line = await PayrollLine.findOne({ _id: objectId(req.params.id, 'Payslip'), employeeId: employeeIdOf(req) }).lean()
    const period = line && (await PayrollPeriod.findOne({ _id: line.periodId, status: 'released' }).lean())
    if (!line || !period) throw notFound('Payslip')
    return azonePayslip(line, period)
  }),
)

/* -------------------------------- Attendance -------------------------------- */

azoneRouter.get(
  '/attendance/today',
  handler(async (req) => {
    const today = manilaDate()
    const [day] = await employeeDays(employeeIdOf(req), today, today)
    return azoneDay(day)
  }),
)

const punchOrder = ['timeIn', 'breakOut', 'breakIn', 'timeOut'] as const

azoneRouter.post(
  '/attendance/punch',
  handler(async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(punchOrder) }), req.body)
    const employeeId = employeeIdOf(req)
    const today = manilaDate()
    const record = (await Attendance.findOne({ employeeId, date: today })) ?? new Attendance({ employeeId, date: today, source: 'azone' })
    // Punches must happen in order: time in → break out → break in → time out
    const next = punchOrder.find((k) => !record[k])
    if (next !== kind) throw conflict(next ? `Next punch should be ${next}` : 'You have already timed out today')
    record[kind] = new Date()
    await record.save()
    const [day] = await employeeDays(employeeId, today, today)
    return azoneDay(day)
  }),
)

azoneRouter.get(
  '/attendance',
  handler(async (req) => {
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query)
    const [y, m] = month.split('-').map(Number)
    const days = await employeeDays(employeeIdOf(req), `${month}-01`, `${month}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`)
    return days.map(azoneDay)
  }),
)

azoneRouter.get(
  '/attendance/summary',
  handler(async (req) => {
    const today = manilaDate()
    const month = today.slice(0, 7)
    const [y, m] = month.split('-').map(Number)
    const holidays = await getHolidays()
    const end = `${month}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`
    const days = await employeeDays(employeeIdOf(req), `${month}-01`, today)
    return {
      presentDays: days.filter((d) => d.status === 'present' || d.status === 'late').length,
      workingDays: eachDay(`${month}-01`, end).filter((d) => !isWeekend(d) && !holidays.has(d)).length,
      lateCount: days.filter((d) => d.status === 'late').length,
      // Today isn't an absence yet
      absences: days.filter((d) => d.status === 'absent' && d.date < today).length,
    }
  }),
)

/* ---------------------------------- Leaves ---------------------------------- */

const leaveLabels = { vacation: 'Vacation Leave', sick: 'Sick Leave', emergency: 'Emergency Leave', birthday: 'Birthday Leave' } as const
type PaidLeave = keyof typeof leaveLabels

async function leaveBalances(employeeId: string) {
  const e = await Employee.findById(employeeId).lean()
  if (!e) throw notFound('Employee')
  const year = manilaDate().slice(0, 4)
  const taken = await Leave.find({ employeeId, status: { $in: ['approved', 'pending'] }, start: { $gte: `${year}-01-01` } }).lean()
  return (Object.keys(leaveLabels) as PaidLeave[]).map((type) => {
    const total = e.leaveCredits?.[type] ?? 0
    const used = taken.filter((l) => l.type === type && l.status === 'approved').reduce((s, l) => s + l.days, 0)
    const pending = taken.filter((l) => l.type === type && l.status === 'pending').reduce((s, l) => s + l.days, 0)
    return { type, label: leaveLabels[type], total, used, available: Math.max(0, total - used - pending) }
  })
}

azoneRouter.get(
  '/leaves/balances',
  handler((req) => leaveBalances(employeeIdOf(req))),
)

azoneRouter.get(
  '/leaves',
  handler(async (req) =>
    (
      await Leave.find({ employeeId: employeeIdOf(req) })
        .sort({ createdAt: -1 })
        .lean()
    ).map(azoneLeave),
  ),
)

const leaveSchema = z
  .object({
    type: z.enum(['vacation', 'sick', 'emergency', 'birthday']),
    startDate: isoDay,
    endDate: isoDay,
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date must be on or after the start date', path: ['endDate'] })

azoneRouter.post(
  '/leaves',
  handler(async (req, res) => {
    const input = parse(leaveSchema, req.body)
    const employeeId = employeeIdOf(req)
    const holidays = await getHolidays()
    const days = eachDay(input.startDate, input.endDate).filter((d) => !isWeekend(d) && !holidays.has(d)).length
    if (days === 0) throw badRequest('The selected dates are all rest days or holidays')

    const balance = (await leaveBalances(employeeId)).find((b) => b.type === input.type)!
    if (days > balance.available) throw badRequest(`Not enough ${balance.label.toLowerCase()} credits (${balance.available} left)`)

    const overlap = await Leave.exists({ employeeId, status: { $ne: 'rejected' }, start: { $lte: input.endDate }, end: { $gte: input.startDate } })
    if (overlap) throw conflict('You already have a leave filed on these dates')

    const leave = await Leave.create({
      employeeId,
      type: input.type,
      start: input.startDate,
      end: input.endDate,
      days,
      reason: input.reason,
      paid: true,
    })
    res.status(201)
    return azoneLeave(leave.toObject())
  }),
)

/* --------------------------------- Requests --------------------------------- */

const requestTitles = {
  coe: 'Certificate of Employment',
  schedule_change: 'Schedule Change',
  overtime: 'Overtime Request',
  reimbursement: 'Reimbursement',
  other: 'General Request',
} as const

azoneRouter.get(
  '/requests',
  handler(async (req) =>
    (
      await EmployeeRequest.find({ employeeId: employeeIdOf(req) })
        .sort({ createdAt: -1 })
        .lean()
    ).map(azoneRequest),
  ),
)

azoneRouter.post(
  '/requests',
  handler(async (req, res) => {
    const input = parse(
      z.object({ kind: z.enum(['coe', 'schedule_change', 'overtime', 'reimbursement', 'other']), details: z.string().trim().min(5).max(1000) }),
      req.body,
    )
    const r = await EmployeeRequest.create({
      employeeId: employeeIdOf(req),
      kind: input.kind,
      title: requestTitles[input.kind],
      details: input.details,
    })
    res.status(201)
    return azoneRequest(r.toObject())
  }),
)

/* ------------------------------- Announcements ------------------------------- */

async function visibleAnnouncements(employeeId: string): Promise<mongoose.QueryFilter<unknown>> {
  const e = await Employee.findById(employeeId).select('department').lean()
  return { status: 'published', audience: { $in: ['all', e?.department ?? ''] } }
}

azoneRouter.get(
  '/announcements',
  handler(async (req) => {
    const list = await Announcement.find(await visibleAnnouncements(employeeIdOf(req)))
      .sort({ pinned: -1, publishedAt: -1 })
      .limit(50)
      .lean()
    return list.map(azoneAnnouncement)
  }),
)

azoneRouter.get(
  '/announcements/:id',
  handler(async (req) => {
    const a = await Announcement.findOne({ _id: objectId(req.params.id, 'Announcement'), ...(await visibleAnnouncements(employeeIdOf(req))) }).lean()
    if (!a) throw notFound('Announcement')
    return azoneAnnouncement(a)
  }),
)

/* ------------------------------- Notifications ------------------------------- */

azoneRouter.get(
  '/notifications',
  handler(async (req) =>
    (
      await Notification.find({ employeeId: employeeIdOf(req) })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ).map(azoneNotification),
  ),
)

azoneRouter.post(
  '/notifications/read',
  handler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(100).optional() }), req.body ?? {})
    const filter = { employeeId: employeeIdOf(req), ...(ids ? { _id: { $in: ids.map((i) => objectId(i, 'Notification')) } } : {}) }
    await Notification.updateMany(filter, { $set: { read: true } })
    res.status(204).end()
  }),
)

/* ---------------------------------- Company ---------------------------------- */

azoneRouter.get(
  '/company',
  handler(async () => {
    const company = await getSetting<CompanyInfo | null>('company', null)
    if (!company) throw notFound('Company information')
    const today = manilaDate()
    return { ...company, holidays: company.holidays.filter((h) => h.date >= today) }
  }),
)
