import type { schema } from '../db/index.js'
import { money } from '../lib/money.js'

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect']
type Employee = Row<typeof schema.employees>
type Period = Row<typeof schema.payrollPeriods>
type Line = Row<typeof schema.payrollLines>
type Named = { firstName: string; lastName: string; department: string } | undefined

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined)
const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`

/** Keep only the last few characters of a government ID or account number. */
export function mask(value: string | null | undefined, visible = 3) {
  if (!value) return ''
  const chars = value.split('')
  let shown = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    if (/[0-9A-Za-z]/.test(chars[i])) chars[i] = shown++ < visible ? chars[i] : '•'
  }
  return chars.join('')
}

/* ---------------------------------- AZONE ---------------------------------- */

/** What an employee sees about themselves — no salary, masked government IDs. */
export function azoneEmployee(e: Employee) {
  return {
    id: e.id,
    employeeNo: e.employeeNo,
    firstName: e.firstName,
    lastName: e.lastName,
    fullName: fullName(e),
    position: e.position,
    department: e.department,
    employmentType: e.employmentType,
    email: e.email,
    phone: e.phone,
    address: e.address,
    birthday: e.birthday ?? '',
    dateHired: e.hireDate,
    manager: e.manager,
    workSchedule: e.workSchedule,
    govIds: { sss: mask(e.sss), philhealth: mask(e.philhealth), pagibig: mask(e.pagibig, 4), tin: mask(e.tin, 6) },
    emergencyContact: { name: e.emergencyName, relation: e.emergencyRelation, phone: e.emergencyPhone },
  }
}

/** A released payroll line rendered as an employee payslip. */
export function azonePayslip(line: Line, period: Period) {
  const lessTime = Number(line.absencesDeduction) + Number(line.lateDeduction)
  return {
    id: line.id,
    periodStart: period.startDate,
    periodEnd: period.endDate,
    payDate: period.payDate,
    gross: money(line.grossPay),
    totalDeductions: money(line.totalDeductions),
    net: money(line.netPay),
    earnings: [
      { label: 'Basic Pay', amount: money(line.basicPay) },
      { label: 'Overtime', amount: money(line.overtimePay) },
      ...line.allowanceItems.map((a) => ({ label: a.label, amount: money(a.amount) })),
      ...(lessTime > 0 ? [{ label: 'Absences / Late', amount: `-${lessTime.toFixed(2)}` }] : []),
    ],
    deductions: [
      { label: 'SSS Contribution', amount: money(line.sss) },
      { label: 'PhilHealth', amount: money(line.philhealth) },
      { label: 'Pag-IBIG', amount: money(line.pagibig) },
      { label: 'Withholding Tax', amount: money(line.withholdingTax) },
      ...line.deductionItems.map((d) => ({ label: d.label, amount: money(d.amount) })),
    ],
    status: 'released' as const,
  }
}

export function azoneAnnouncement(a: Row<typeof schema.announcements>) {
  const firstParagraph = a.body.split('\n')[0]
  return {
    id: a.id,
    category: a.category,
    title: a.title,
    excerpt: firstParagraph.length > 160 ? `${firstParagraph.slice(0, 157)}…` : firstParagraph,
    body: a.body,
    publishedAt: a.publishedAt.toISOString(),
    author: a.author,
    pinned: a.pinned,
  }
}

export const azoneLeave = (l: Row<typeof schema.leaves>) => ({
  id: l.id,
  type: l.type,
  startDate: l.startDate,
  endDate: l.endDate,
  days: l.days,
  reason: l.reason,
  status: l.status,
  filedAt: l.createdAt.toISOString(),
})

export const azoneRequest = (r: Row<typeof schema.employeeRequests>) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  details: r.details,
  status: r.status,
  filedAt: r.createdAt.toISOString(),
})

export const azoneNotification = (n: Row<typeof schema.notifications>) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  link: n.link ?? undefined,
  read: n.read,
  createdAt: n.createdAt.toISOString(),
})

type Day = {
  date: string
  timeIn: Date | null
  breakOut: Date | null
  breakIn: Date | null
  timeOut: Date | null
  status: string
  hoursWorked: number
}

export const azoneDay = (d: Day) => ({
  ...d,
  timeIn: iso(d.timeIn) ?? null,
  breakOut: iso(d.breakOut) ?? null,
  breakIn: iso(d.breakIn) ?? null,
  timeOut: iso(d.timeOut) ?? null,
})

/* ----------------------------------- APAY ----------------------------------- */

export function apayEmployee(e: Employee) {
  return {
    id: e.id,
    employeeNo: e.employeeNo,
    firstName: e.firstName,
    lastName: e.lastName,
    fullName: fullName(e),
    email: e.email,
    position: e.position,
    department: e.department,
    employmentType: e.employmentType,
    status: e.status,
    monthlyBasic: money(e.monthlyBasic),
    hireDate: e.hireDate,
    taxStatus: e.taxStatus,
    bank: { name: e.bankName, account: mask(e.bankAccount, 4) },
    govIds: { sss: e.sss, philhealth: e.philhealth, pagibig: e.pagibig, tin: e.tin },
  }
}

export function apayPeriod(p: Period) {
  return {
    id: p.id,
    label: p.label,
    start: p.startDate,
    end: p.endDate,
    payDate: p.payDate,
    status: p.status,
    headcount: p.headcount,
    gross: money(p.gross),
    deductions: money(p.deductions),
    net: money(p.net),
    employerContributions: money(p.employerContributions),
    computedAt: iso(p.computedAt),
    approvedBy: p.approvedBy ?? undefined,
    releasedAt: iso(p.releasedAt),
  }
}

export function apayLine(l: Line) {
  return {
    employeeId: l.employeeId,
    employeeNo: l.employeeNo,
    name: l.name,
    department: l.department,
    monthlyBasic: money(l.monthlyBasic),
    basicPay: money(l.basicPay),
    overtimePay: money(l.overtimePay),
    allowances: money(l.allowances),
    absencesDeduction: money(l.absencesDeduction),
    lateDeduction: money(l.lateDeduction),
    grossPay: money(l.grossPay),
    sss: money(l.sss),
    philhealth: money(l.philhealth),
    pagibig: money(l.pagibig),
    taxableIncome: money(l.taxableIncome),
    withholdingTax: money(l.withholdingTax),
    otherDeductions: money(l.otherDeductions),
    totalDeductions: money(l.totalDeductions),
    netPay: money(l.netPay),
    employer: { sss: money(l.employerSss), philhealth: money(l.employerPhilhealth), pagibig: money(l.employerPagibig) },
  }
}

export const apayAdjustment = (a: Row<typeof schema.adjustments>, emp: Named) => ({
  id: a.id,
  employeeId: a.employeeId,
  employeeName: emp ? fullName(emp) : 'Unknown',
  kind: a.kind,
  category: a.category,
  name: a.name,
  amount: money(a.amount),
  balance: a.balance != null ? money(a.balance) : undefined,
  active: a.active,
})

export const apayOvertime = (o: Row<typeof schema.overtime>, emp: Named) => ({
  id: o.id,
  employeeId: o.employeeId,
  employeeName: emp ? fullName(emp) : 'Unknown',
  department: emp?.department ?? '',
  date: o.date,
  hours: o.hours,
  kind: o.kind,
  reason: o.reason,
  status: o.status,
})

export const apayLeave = (l: Row<typeof schema.leaves>, emp: Named) => ({
  id: l.id,
  employeeId: l.employeeId,
  employeeName: emp ? fullName(emp) : 'Unknown',
  department: emp?.department ?? '',
  type: l.type,
  start: l.startDate,
  end: l.endDate,
  days: l.days,
  paid: l.paid,
  status: l.status,
})

export const apayAnnouncement = (a: Row<typeof schema.announcements>) => ({
  id: a.id,
  category: a.category,
  title: a.title,
  body: a.body,
  author: a.author,
  publishedAt: a.publishedAt.toISOString(),
  status: a.status,
  audience: a.audience,
})

export const apayAudit = (a: Row<typeof schema.auditLog>) => ({
  id: a.id,
  at: a.createdAt.toISOString(),
  actor: a.actor,
  action: a.action,
  target: a.target,
})
