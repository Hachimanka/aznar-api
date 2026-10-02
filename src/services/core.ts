import type { Request } from 'express'
import type { ClientSession, Types } from 'mongoose'
import { Audit, Notification, Setting } from '../models/index.js'

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

export async function getSetting<T>(key: 'payroll' | 'company', fallback: T): Promise<T> {
  const doc = await Setting.findOne({ key }).lean()
  return doc ? ({ ...fallback, ...(doc.value as object) } as T) : fallback
}

export const getPayrollSettings = () => getSetting<PayrollSettings>('payroll', defaultPayrollSettings)

export async function getHolidays() {
  const company = await getSetting<CompanyInfo | null>('company', null)
  return new Set((company?.holidays ?? []).map((h) => h.date))
}

export async function saveSetting(key: string, value: unknown) {
  await Setting.updateOne({ key }, { $set: { value } }, { upsert: true })
}

/* ---------------------------------- Audit ---------------------------------- */

export async function audit(req: Request, action: string, target: string, session?: ClientSession) {
  await Audit.create([{ actor: req.auth?.name ?? 'System', actorId: req.auth?.userId, action, target }], { session })
}

/* ------------------------------ Notifications ------------------------------ */

type NotificationInput = {
  kind: 'payslip' | 'leave' | 'announcement' | 'request' | 'attendance'
  title: string
  body?: string
  link?: string
}

/** Send the same notification to many employees (shows in their AZONE bell). */
export async function notify(employeeIds: (string | Types.ObjectId)[], n: NotificationInput, session?: ClientSession) {
  if (!employeeIds.length) return
  await Notification.insertMany(
    employeeIds.map((employeeId) => ({ employeeId, ...n })),
    { session },
  )
}
