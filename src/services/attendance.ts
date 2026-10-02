import type { Types } from 'mongoose'
import { Attendance, Leave, Overtime } from '../models/index.js'
import { eachDay, isWeekend, manilaDate, manilaMinutes } from '../lib/dates.js'
import type { OvertimeKind } from '../lib/payroll.js'
import { getHolidays, getPayrollSettings } from './core.js'

export type DayStatus = 'present' | 'late' | 'absent' | 'leave' | 'rest' | 'holiday'

type AttendanceRecord = {
  date: string
  timeIn?: Date | null
  breakOut?: Date | null
  breakIn?: Date | null
  timeOut?: Date | null
}

type LeaveLite = { start: string; end: string; paid: boolean; type: string }

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

const coveredBy = (day: string, leaves: LeaveLite[]) => leaves.find((l) => l.start <= day && day <= l.end)

/** Day-by-day records for one employee (AZONE DTR). Only days up to today. */
export async function employeeDays(employeeId: string | Types.ObjectId, start: string, end: string) {
  const today = manilaDate()
  const last = end < today ? end : today
  if (start > last) return []
  const [records, leaves, holidays, settings] = await Promise.all([
    Attendance.find({ employeeId, date: { $gte: start, $lte: last } }).lean(),
    Leave.find({ employeeId, status: 'approved', start: { $lte: last }, end: { $gte: start } }).lean(),
    getHolidays(),
    getPayrollSettings(),
  ])
  const byDate = new Map(records.map((r) => [r.date, r]))

  return eachDay(start, last).map((date) => {
    const r = byDate.get(date)
    let status: DayStatus
    if (r?.timeIn) status = lateMinutes(r.timeIn, settings.shiftStartMinutes, settings.graceMinutes) ? 'late' : 'present'
    else if (coveredBy(date, leaves)) status = 'leave'
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
}

/**
 * Attendance summary per employee for a cut-off — the payroll input.
 * Working days still in the future count as present (payroll is often prepared before the cut-off ends).
 */
export async function periodAttendance(employeeIds: Types.ObjectId[], start: string, end: string) {
  const today = manilaDate()
  const [records, leaves, overtime, holidays, settings] = await Promise.all([
    Attendance.find({ employeeId: { $in: employeeIds }, date: { $gte: start, $lte: end } }).lean(),
    Leave.find({ employeeId: { $in: employeeIds }, status: 'approved', start: { $lte: end }, end: { $gte: start } }).lean(),
    Overtime.find({ employeeId: { $in: employeeIds }, status: 'approved', date: { $gte: start, $lte: end } }).lean(),
    getHolidays(),
    getPayrollSettings(),
  ])
  const workdays = eachDay(start, end).filter((d) => !isWeekend(d) && !holidays.has(d))
  const recordKey = (id: unknown, date: string) => `${id}|${date}`
  const byKey = new Map(records.map((r) => [recordKey(r.employeeId, r.date), r]))

  const out = new Map<string, PeriodAttendance>()
  for (const id of employeeIds) {
    const myLeaves = leaves.filter((l) => l.employeeId.equals(id))
    const s: PeriodAttendance = {
      workingDays: workdays.length,
      daysPresent: 0,
      absentDays: 0,
      lateMinutes: 0,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      overtime: [],
      overtimeHours: 0,
    }
    for (const day of workdays) {
      const leave = coveredBy(day, myLeaves)
      const r = byKey.get(recordKey(id, day))
      if (leave) leave.paid ? s.paidLeaveDays++ : s.unpaidLeaveDays++
      else if (r?.timeIn) {
        s.daysPresent++
        s.lateMinutes += lateMinutes(r.timeIn, settings.shiftStartMinutes, settings.graceMinutes)
      } else if (day < today) s.absentDays++
      else s.daysPresent++
    }
    const byKind = new Map<OvertimeKind, number>()
    for (const ot of overtime.filter((o) => o.employeeId.equals(id)))
      byKind.set(ot.kind as OvertimeKind, (byKind.get(ot.kind as OvertimeKind) ?? 0) + ot.hours)
    s.overtime = [...byKind].map(([kind, hours]) => ({ kind, hours }))
    s.overtimeHours = s.overtime.reduce((t, o) => t + o.hours, 0)
    out.set(String(id), s)
  }
  return out
}

/** Working days between two dates, excluding weekends and company holidays. */
export async function countWorkdays(start: string, end: string) {
  const holidays = await getHolidays()
  return eachDay(start, end).filter((d) => !isWeekend(d) && !holidays.has(d)).length
}
