import type { Request } from 'express'
import { eq } from 'drizzle-orm'
import { db, type Exec } from '../db/index.js'
import { auditLog, notifications, settings } from '../db/schema.js'

/* --------------------------------- Settings --------------------------------- */

export type PayrollSettings = {
  companyName: string
  payFrequency: 'semi-monthly'
  firstCutoff: { start: number; end: number; payDay: number }
  secondCutoff: { start: number; end: number; payDay: string }
  graceMinutes: number
  roundLateTo: number
  requireTwoStepApproval: boolean
  autoPublishToAzone: boolean
  /** Shift start, minutes after midnight (8:00 AM) */
  shiftStartMinutes: number
}

export type CompanyInfo = {
  name: string
  about: string
  mission: string
  vision: string
  values: { title: string; description: string }[]
  offices: { name: string; address: string; phone: string }[]
  hotlines: { label: string; value: string }[]
  holidays: { date: string; name: string; type: 'Regular' | 'Special' }[]
}

export const defaultPayrollSettings: PayrollSettings = {
  companyName: 'Aznar',
  payFrequency: 'semi-monthly',
  firstCutoff: { start: 1, end: 15, payDay: 15 },
  secondCutoff: { start: 16, end: 31, payDay: 'last' },
  graceMinutes: 5,
  roundLateTo: 1,
  requireTwoStepApproval: true,
  autoPublishToAzone: true,
  shiftStartMinutes: 8 * 60,
}

export async function getSetting<T>(key: 'payroll' | 'company', fallback: T, q: Exec = db()): Promise<T> {
  const [row] = await q.select().from(settings).where(eq(settings.key, key))
  return row ? ({ ...fallback, ...(row.value as object) } as T) : fallback
}

export const getPayrollSettings = (q?: Exec) => getSetting<PayrollSettings>('payroll', defaultPayrollSettings, q)

export async function getHolidays(q?: Exec) {
  const company = await getSetting<CompanyInfo | null>('company', null, q)
  return new Set((company?.holidays ?? []).map((h) => h.date))
}

export async function saveSetting(key: string, value: unknown) {
  await db().insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } })
}

/* ---------------------------------- Audit ---------------------------------- */

export async function audit(req: Request, action: string, target: string, q: Exec = db()) {
  await q.insert(auditLog).values({ actor: req.auth?.name ?? 'System', actorId: req.auth?.userId, action, target })
}

/* ------------------------------ Notifications ------------------------------ */

type NotificationInput = {
  kind: 'payslip' | 'leave' | 'announcement' | 'request' | 'attendance'
  title: string
  body?: string
  link?: string
}

/** Send the same notification to many employees (shows in their AZONE bell). */
export async function notify(employeeIds: string[], n: NotificationInput, q: Exec = db()) {
  if (!employeeIds.length) return
  await q.insert(notifications).values(employeeIds.map((employeeId) => ({ employeeId, ...n })))
}
