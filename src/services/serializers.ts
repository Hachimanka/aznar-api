import { money } from '../lib/money.js'

type Doc = Record<string, any>

const id = (d: Doc) => String(d._id)
const fullName = (e: Doc) => `${e.firstName} ${e.lastName}`

/** Keep only the last few characters of a government ID. */
export function mask(value: string, visible = 3) {
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
export function azoneEmployee(e: Doc) {
  return {
    id: id(e),
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
    birthday: e.birthday,
    dateHired: e.hireDate,
    manager: e.manager,
    workSchedule: e.workSchedule,
    govIds: { sss: mask(e.govIds?.sss), philhealth: mask(e.govIds?.philhealth), pagibig: mask(e.govIds?.pagibig, 4), tin: mask(e.govIds?.tin, 6) },
    emergencyContact: e.emergencyContact,
  }
}

/** A released payroll line rendered as an employee payslip. */
export function azonePayslip(line: Doc, period: Doc) {
  const lessTime = Number(money(line.absencesDeduction)) + Number(money(line.lateDeduction))
  return {
    id: id(line),
    periodStart: period.start,
    periodEnd: period.end,
    payDate: period.payDate,
    gross: money(line.grossPay),
    totalDeductions: money(line.totalDeductions),
    net: money(line.netPay),
    earnings: [
      { label: 'Basic Pay', amount: money(line.basicPay) },
      { label: 'Overtime', amount: money(line.overtimePay) },
      ...(line.allowanceItems ?? []).map((a: Doc) => ({ label: a.label, amount: money(a.amount) })),
      ...(lessTime > 0 ? [{ label: 'Absences / Late', amount: `-${lessTime.toFixed(2)}` }] : []),
    ],
    deductions: [
      { label: 'SSS Contribution', amount: money(line.sss) },
      { label: 'PhilHealth', amount: money(line.philhealth) },
      { label: 'Pag-IBIG', amount: money(line.pagibig) },
      { label: 'Withholding Tax', amount: money(line.withholdingTax) },
      ...(line.deductionItems ?? []).map((d: Doc) => ({ label: d.label, amount: money(d.amount) })),
    ],
    status: 'released' as const,
  }
}

export function azoneAnnouncement(a: Doc) {
  const firstParagraph = String(a.body).split('\n')[0]
  return {
    id: id(a),
    category: a.category,
    title: a.title,
    excerpt: firstParagraph.length > 160 ? `${firstParagraph.slice(0, 157)}…` : firstParagraph,
    body: a.body,
    publishedAt: new Date(a.publishedAt).toISOString(),
    author: a.author,
    pinned: !!a.pinned,
  }
}

export const azoneLeave = (l: Doc) => ({
  id: id(l),
  type: l.type,
  startDate: l.start,
  endDate: l.end,
  days: l.days,
  reason: l.reason,
  status: l.status,
  filedAt: new Date(l.createdAt).toISOString(),
})

export const azoneRequest = (r: Doc) => ({
  id: id(r),
  kind: r.kind,
  title: r.title,
  details: r.details,
  status: r.status,
  filedAt: new Date(r.createdAt).toISOString(),
})

export const azoneNotification = (n: Doc) => ({
  id: id(n),
  kind: n.kind,
  title: n.title,
  body: n.body,
  link: n.link,
  read: n.read,
  createdAt: new Date(n.createdAt).toISOString(),
})

export const azoneDay = (d: Doc) => ({
  ...d,
  timeIn: d.timeIn ? new Date(d.timeIn).toISOString() : null,
  breakOut: d.breakOut ? new Date(d.breakOut).toISOString() : null,
  breakIn: d.breakIn ? new Date(d.breakIn).toISOString() : null,
  timeOut: d.timeOut ? new Date(d.timeOut).toISOString() : null,
})

/* ----------------------------------- APAY ----------------------------------- */

export function apayEmployee(e: Doc) {
  return {
    id: id(e),
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
    bank: { name: e.bank?.name ?? '', account: mask(e.bank?.account ?? '', 4) },
    govIds: e.govIds,
  }
}

export function apayPeriod(p: Doc) {
  return {
    id: id(p),
    label: p.label,
    start: p.start,
    end: p.end,
    payDate: p.payDate,
    status: p.status,
    headcount: p.headcount,
    gross: money(p.gross),
    deductions: money(p.deductions),
    net: money(p.net),
    employerContributions: money(p.employerContributions),
    computedAt: p.computedAt?.toISOString?.(),
    approvedBy: p.approvedBy ?? undefined,
    releasedAt: p.releasedAt?.toISOString?.(),
  }
}

const lineMoneyFields = [
  'monthlyBasic',
  'basicPay',
  'overtimePay',
  'allowances',
  'absencesDeduction',
  'lateDeduction',
  'grossPay',
  'sss',
  'philhealth',
  'pagibig',
  'taxableIncome',
  'withholdingTax',
  'otherDeductions',
  'totalDeductions',
  'netPay',
] as const

export function apayLine(l: Doc) {
  return {
    employeeId: String(l.employeeId),
    employeeNo: l.employeeNo,
    name: l.name,
    department: l.department,
    ...Object.fromEntries(lineMoneyFields.map((k) => [k, money(l[k])])),
    employer: { sss: money(l.employer?.sss), philhealth: money(l.employer?.philhealth), pagibig: money(l.employer?.pagibig) },
  }
}

export const apayAdjustment = (a: Doc, names: Map<string, string>) => ({
  id: id(a),
  employeeId: String(a.employeeId),
  employeeName: names.get(String(a.employeeId)) ?? 'Unknown',
  kind: a.kind,
  category: a.category,
  name: a.name,
  amount: money(a.amount),
  balance: a.balance != null ? money(a.balance) : undefined,
  active: a.active,
})

export const apayOvertime = (o: Doc, emp?: Doc) => ({
  id: id(o),
  employeeId: String(o.employeeId),
  employeeName: emp ? fullName(emp) : 'Unknown',
  department: emp?.department ?? '',
  date: o.date,
  hours: o.hours,
  kind: o.kind,
  reason: o.reason,
  status: o.status,
})

export const apayLeave = (l: Doc, emp?: Doc) => ({
  id: id(l),
  employeeId: String(l.employeeId),
  employeeName: emp ? fullName(emp) : 'Unknown',
  department: emp?.department ?? '',
  type: l.type,
  start: l.start,
  end: l.end,
  days: l.days,
  paid: l.paid,
  status: l.status,
})

export const apayAnnouncement = (a: Doc) => ({
  id: id(a),
  category: a.category,
  title: a.title,
  body: a.body,
  author: a.author,
  publishedAt: new Date(a.publishedAt).toISOString(),
  status: a.status,
  audience: a.audience,
})

export const apayAudit = (a: Doc) => ({ id: id(a), at: new Date(a.createdAt).toISOString(), actor: a.actor, action: a.action, target: a.target })
