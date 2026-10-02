import { Router } from 'express'
import { and, desc, eq, gte, inArray, lte, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { announcements, attendance, employeeRequests, employees, leaves, notifications, payrollLines, payrollPeriods } from '../db/schema.js'
import { badRequest, conflict, handler, isoDay, notFound, parse, uuid } from '../lib/http.js'
import { eachDay, isWeekend, lastDayOfMonth, manilaDate } from '../lib/dates.js'
import { employeeIdOf, requireAuth } from '../middleware/auth.js'
import { employeeDays } from '../services/attendance.js'
import { getHolidays, getSetting, type CompanyInfo } from '../services/core.js'
import { azoneAnnouncement, azoneDay, azoneEmployee, azoneLeave, azoneNotification, azonePayslip, azoneRequest } from '../services/serializers.js'

/** Employee self-service. Every route acts only on the signed-in employee's own data. */
export const azoneRouter = Router()
azoneRouter.use(requireAuth('azone'))

async function me(employeeId: string) {
  const [e] = await db().select().from(employees).where(eq(employees.id, employeeId))
  if (!e) throw notFound('Employee')
  return e
}

/* --------------------------------- Profile --------------------------------- */

azoneRouter.get(
  '/me',
  handler(async (req) => azoneEmployee(await me(employeeIdOf(req)))),
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
    const [e] = await db()
      .update(employees)
      .set({
        phone: input.phone,
        address: input.address,
        emergencyName: input.emergencyContact.name,
        emergencyRelation: input.emergencyContact.relation,
        emergencyPhone: input.emergencyContact.phone,
      })
      .where(eq(employees.id, employeeIdOf(req)))
      .returning()
    if (!e) throw notFound('Employee')
    return azoneEmployee(e)
  }),
)

/* --------------------------------- Payslips --------------------------------- */

azoneRouter.get(
  '/payslips',
  handler(async (req) => {
    const rows = await db()
      .select({ line: payrollLines, period: payrollPeriods })
      .from(payrollLines)
      .innerJoin(payrollPeriods, eq(payrollLines.periodId, payrollPeriods.id))
      .where(and(eq(payrollLines.employeeId, employeeIdOf(req)), eq(payrollPeriods.status, 'released')))
      .orderBy(desc(payrollPeriods.endDate))
    return rows.map((r) => azonePayslip(r.line, r.period))
  }),
)

azoneRouter.get(
  '/payslips/:id',
  handler(async (req) => {
    const [row] = await db()
      .select({ line: payrollLines, period: payrollPeriods })
      .from(payrollLines)
      .innerJoin(payrollPeriods, eq(payrollLines.periodId, payrollPeriods.id))
      .where(
        and(
          eq(payrollLines.id, uuid(req.params.id, 'Payslip')),
          eq(payrollLines.employeeId, employeeIdOf(req)),
          eq(payrollPeriods.status, 'released'),
        ),
      )
    if (!row) throw notFound('Payslip')
    return azonePayslip(row.line, row.period)
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
    await db().transaction(async (tx) => {
      await tx.insert(attendance).values({ employeeId, date: today, source: 'azone' }).onConflictDoNothing()
      const [record] = await tx
        .select()
        .from(attendance)
        .where(and(eq(attendance.employeeId, employeeId), eq(attendance.date, today)))
        .for('update')
      // Punches must happen in order: time in → break out → break in → time out
      const next = punchOrder.find((k) => !record[k])
      if (next !== kind) throw conflict(next ? `Next punch should be ${next}` : 'You have already timed out today')
      await tx
        .update(attendance)
        .set({ [kind]: new Date() })
        .where(eq(attendance.id, record.id))
    })
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
  const e = await me(employeeId)
  const credits: Record<PaidLeave, number> = {
    vacation: e.vacationCredits,
    sick: e.sickCredits,
    emergency: e.emergencyCredits,
    birthday: e.birthdayCredits,
  }
  const year = manilaDate().slice(0, 4)
  const taken = await db()
    .select()
    .from(leaves)
    .where(and(eq(leaves.employeeId, employeeId), inArray(leaves.status, ['approved', 'pending']), gte(leaves.startDate, `${year}-01-01`)))
  return (Object.keys(leaveLabels) as PaidLeave[]).map((type) => {
    const total = credits[type]
    const days = (status: string) => taken.filter((l) => l.type === type && l.status === status).reduce((s, l) => s + l.days, 0)
    const used = days('approved')
    return { type, label: leaveLabels[type], total, used, available: Math.max(0, total - used - days('pending')) }
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
      await db()
        .select()
        .from(leaves)
        .where(eq(leaves.employeeId, employeeIdOf(req)))
        .orderBy(desc(leaves.createdAt))
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

    const [overlap] = await db()
      .select({ id: leaves.id })
      .from(leaves)
      .where(
        and(
          eq(leaves.employeeId, employeeId),
          ne(leaves.status, 'rejected'),
          lte(leaves.startDate, input.endDate),
          gte(leaves.endDate, input.startDate),
        ),
      )
      .limit(1)
    if (overlap) throw conflict('You already have a leave filed on these dates')

    const [leave] = await db()
      .insert(leaves)
      .values({ employeeId, type: input.type, startDate: input.startDate, endDate: input.endDate, days, reason: input.reason, paid: true })
      .returning()
    res.status(201)
    return azoneLeave(leave)
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
      await db()
        .select()
        .from(employeeRequests)
        .where(eq(employeeRequests.employeeId, employeeIdOf(req)))
        .orderBy(desc(employeeRequests.createdAt))
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
    const [r] = await db()
      .insert(employeeRequests)
      .values({ employeeId: employeeIdOf(req), kind: input.kind, title: requestTitles[input.kind], details: input.details })
      .returning()
    res.status(201)
    return azoneRequest(r)
  }),
)

/* ------------------------------- Announcements ------------------------------- */

async function visibleTo(employeeId: string) {
  const e = await me(employeeId)
  return and(eq(announcements.status, 'published'), or(eq(announcements.audience, 'all'), eq(announcements.audience, e.department)))
}

azoneRouter.get(
  '/announcements',
  handler(async (req) => {
    const list = await db()
      .select()
      .from(announcements)
      .where(await visibleTo(employeeIdOf(req)))
      .orderBy(desc(announcements.pinned), desc(announcements.publishedAt))
      .limit(50)
    return list.map(azoneAnnouncement)
  }),
)

azoneRouter.get(
  '/announcements/:id',
  handler(async (req) => {
    const [a] = await db()
      .select()
      .from(announcements)
      .where(and(eq(announcements.id, uuid(req.params.id, 'Announcement')), await visibleTo(employeeIdOf(req))))
    if (!a) throw notFound('Announcement')
    return azoneAnnouncement(a)
  }),
)

/* ------------------------------- Notifications ------------------------------- */

azoneRouter.get(
  '/notifications',
  handler(async (req) =>
    (
      await db()
        .select()
        .from(notifications)
        .where(eq(notifications.employeeId, employeeIdOf(req)))
        .orderBy(desc(notifications.createdAt))
        .limit(50)
    ).map(azoneNotification),
  ),
)

azoneRouter.post(
  '/notifications/read',
  handler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(100).optional() }), req.body ?? {})
    const mine = eq(notifications.employeeId, employeeIdOf(req))
    await db()
      .update(notifications)
      .set({ read: true })
      .where(
        ids
          ? and(
              mine,
              inArray(
                notifications.id,
                ids.map((i) => uuid(i, 'Notification')),
              ),
            )
          : mine,
      )
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
