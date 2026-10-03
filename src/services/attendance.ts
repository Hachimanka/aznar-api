import { and, between, eq, gte, inArray, lte } from 'drizzle-orm'
import { db, type Exec } from '../db/index.js'
import { attendance, attendanceOverrides, leaves, overtime } from '../db/schema.js'
import { eachDay, isWeekend, manilaDate, manilaMinutes } from '../lib/dates.js'
import type { OvertimeKind } from '../lib/payroll.js'
import { getHolidays, getPayrollSettings } from './core.js'

export type DayStatus = 'present' | 'late' | 'absent' | 'leave' | 'rest' | 'holiday'

type AttendanceRecord = {
  timeIn: Date | null
  breakOut: Date | null
  breakIn: Date | null
  timeOut: Date | null
}

type LeaveLite = { startDate: string; endDate: string; paid: boolean }

/** Minutes late after the grace period (0 if within grace). */
export function lateMinutes(timeIn: Date, shiftStart: number, grace: number) {
  const late = manilaMinutes(timeIn) - shiftStart
  return late > grace ? late : 0
}

export function hoursWorked(r: AttendanceRecord) {
  if (!r.timeIn || !r.timeOut) return 0
  const breakMs = r.breakOut && r.breakIn ? r.breakIn.getTime() - r.breakOut.getTime() : 60 * 60 * 1000
  return Math.max(0, Math.round(((r.timeOut.getTime() - r.timeIn.getTime() - breakMs) / 36e5) * 10) / 10)
}

const coveredBy = (day: string, list: LeaveLite[]) => list.find((l) => l.startDate <= day && day <= l.endDate)
const overlapping = (start: string, end: string) => and(lte(leaves.startDate, end), gte(leaves.endDate, start))

/** Day-by-day records for one employee (AZONE DTR). Only days up to today. */
export async function employeeDays(employeeId: string, start: string, end: string) {
  const today = manilaDate()
  const last = end < today ? end : today
  if (start > last) return []
  const [records, approved, holidays, settings] = await Promise.all([
    db()
      .select()
      .from(attendance)
      .where(and(eq(attendance.employeeId, employeeId), between(attendance.date, start, last))),
    db()
      .select()
      .from(leaves)
      .where(and(eq(leaves.employeeId, employeeId), eq(leaves.status, 'approved'), overlapping(start, last))),
    getHolidays(),
    getPayrollSettings(),
  ])
  const byDate = new Map(records.map((r) => [r.date, r]))

  return eachDay(start, last).map((date) => {
    const r = byDate.get(date)
    let status: DayStatus
    if (r?.timeIn) status = lateMinutes(r.timeIn, settings.shiftStartMinutes, settings.graceMinutes) ? 'late' : 'present'
    else if (coveredBy(date, approved)) status = 'leave'
    else if (holidays.has(date)) status = 'holiday'
    else if (isWeekend(date)) status = 'rest'
    else status = 'absent'
    return {
      date,
      timeIn: r?.timeIn ?? null,
      breakOut: r?.breakOut ?? null,
      breakIn: r?.breakIn ?? null,
      timeOut: r?.timeOut ?? null,
      status,
      hoursWorked: r ? hoursWorked(r) : 0,
    }
  })
}

export type PeriodAttendance = {
  workingDays: number
  daysPresent: number
  absentDays: number
  lateMinutes: number
  paidLeaveDays: number
  unpaidLeaveDays: number
  overtime: { kind: OvertimeKind; hours: number }[]
  overtimeHours: number
  /** Where the day counts came from: daily records, or HR's edit/upload for this cut-off */
  source: 'dtr' | 'manual' | 'upload'
}

/**
 * Attendance summary per employee for a cut-off — the payroll input.
 * Working days still in the future count as present (payroll is often prepared before the cut-off ends).
 */
export async function periodAttendance(employeeIds: string[], start: string, end: string, q: Exec = db()) {
  const out = new Map<string, PeriodAttendance>()
  if (!employeeIds.length) return out
  const today = manilaDate()
  const [records, approved, ot, holidays, settings] = await Promise.all([
    q
      .select()
      .from(attendance)
      .where(and(inArray(attendance.employeeId, employeeIds), between(attendance.date, start, end))),
    q
      .select()
      .from(leaves)
      .where(and(inArray(leaves.employeeId, employeeIds), eq(leaves.status, 'approved'), overlapping(start, end))),
    q
      .select()
      .from(overtime)
      .where(and(inArray(overtime.employeeId, employeeIds), eq(overtime.status, 'approved'), between(overtime.date, start, end))),
    getHolidays(q),
    getPayrollSettings(q),
  ])
  const workdays = eachDay(start, end).filter((d) => !isWeekend(d) && !holidays.has(d))
  const byKey = new Map(records.map((r) => [`${r.employeeId}|${r.date}`, r]))

  for (const id of employeeIds) {
    const mine = approved.filter((l) => l.employeeId === id)
    const s: PeriodAttendance = {
      workingDays: workdays.length,
      daysPresent: 0,
      absentDays: 0,
      lateMinutes: 0,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      overtime: [],
      overtimeHours: 0,
      source: 'dtr',
    }
    for (const day of workdays) {
      const leave = coveredBy(day, mine)
      const r = byKey.get(`${id}|${day}`)
      if (leave) leave.paid ? s.paidLeaveDays++ : s.unpaidLeaveDays++
      else if (r?.timeIn) {
        s.daysPresent++
        s.lateMinutes += lateMinutes(r.timeIn, settings.shiftStartMinutes, settings.graceMinutes)
      } else if (day < today) s.absentDays++
      else s.daysPresent++
    }
    const byKind = new Map<OvertimeKind, number>()
    for (const o of ot.filter((o) => o.employeeId === id)) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + o.hours)
    s.overtime = [...byKind].map(([kind, hours]) => ({ kind, hours }))
    s.overtimeHours = s.overtime.reduce((t, o) => t + o.hours, 0)
    out.set(id, s)
  }
  return out
}

/**
 * The cut-off summary payroll actually uses: DTR-derived, with HR's edited/uploaded rows taking precedence.
 * Overtime always comes from approved filings — it carries per-kind multipliers an override can't express.
 */
export async function cutoffAttendance(period: { id: string; startDate: string; endDate: string }, employeeIds: string[], q: Exec = db()) {
  const [summary, overrides] = await Promise.all([
    periodAttendance(employeeIds, period.startDate, period.endDate, q),
    employeeIds.length ? q.select().from(attendanceOverrides).where(eq(attendanceOverrides.periodId, period.id)) : Promise.resolve([]),
  ])
  for (const o of overrides) {
    const s = summary.get(o.employeeId)
    if (!s) continue
    s.daysPresent = o.daysPresent
    s.absentDays = o.absentDays
    s.lateMinutes = o.lateMinutes
    s.paidLeaveDays = o.paidLeaveDays
    s.unpaidLeaveDays = o.unpaidLeaveDays
    s.source = o.source
  }
  return summary
}
