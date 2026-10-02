import mongoose, { type ClientSession } from 'mongoose'
import { Decimal } from 'decimal.js'
import { Adjustment, Employee, PayrollLine, PayrollPeriod } from '../models/index.js'
import { computeCutoff, sum } from '../lib/payroll.js'
import { cutoffFor, manilaDate, periodLabel } from '../lib/dates.js'
import { D128, money } from '../lib/money.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js'
import { can, type Role } from '../lib/permissions.js'
import { periodAttendance } from './attendance.js'
import { notify } from './core.js'

export type PeriodStatus = 'draft' | 'computed' | 'review' | 'approved' | 'released'

/** Make sure the cut-off containing today exists, so there's always an open period to process. */
export async function ensureCurrentPeriod(today = manilaDate()) {
  const { start, end } = cutoffFor(today)
  await PayrollPeriod.updateOne(
    { end },
    { $setOnInsert: { start, end, label: periodLabel(start, end), payDate: end, status: 'draft' } },
    { upsert: true },
  )
}

/** Run the engine for every active employee and replace the period's payroll lines. */
export async function computePeriod(periodId: string, actor: { userId?: string }, session?: ClientSession) {
  const period = await PayrollPeriod.findById(periodId).session(session ?? null)
  if (!period) throw notFound('Payroll period')
  if (!['draft', 'computed'].includes(period.status)) throw conflict(`A ${period.status} payroll can no longer be recomputed`)

  const employees = await Employee.find({ status: { $ne: 'resigned' }, hireDate: { $lte: period.end } })
    .session(session ?? null)
    .lean()
  const ids = employees.map((e) => e._id)
  const [attendance, adjustments] = await Promise.all([
    periodAttendance(ids, period.start, period.end),
    Adjustment.find({ employeeId: { $in: ids }, active: true })
      .session(session ?? null)
      .lean(),
  ])

  const lines = employees.map((e) => {
    const a = attendance.get(String(e._id))!
    const mine = adjustments.filter((x) => x.employeeId.equals(e._id))
    const allowances = mine.filter((x) => x.kind === 'allowance')
    // A loan never deducts more than its remaining balance
    const deductions = mine
      .filter((x) => x.kind === 'deduction')
      .map((x) => ({ label: x.name, amount: money(x.balance != null ? Decimal.min(String(x.amount), String(x.balance)) : x.amount) }))
      .filter((d) => Number(d.amount) > 0)

    const r = computeCutoff({
      monthlyBasic: money(e.monthlyBasic),
      deMinimis: sum(allowances.filter((x) => x.category === 'de_minimis').map((x) => money(x.amount))),
      taxableAllowances: sum(allowances.filter((x) => x.category !== 'de_minimis').map((x) => money(x.amount))),
      absentDays: a.absentDays,
      unpaidLeaveDays: a.unpaidLeaveDays,
      lateMinutes: a.lateMinutes,
      overtime: a.overtime,
      otherDeductions: deductions,
    })

    return {
      periodId: period._id,
      employeeId: e._id,
      employeeNo: e.employeeNo,
      name: `${e.firstName} ${e.lastName}`,
      department: e.department,
      monthlyBasic: e.monthlyBasic,
      basicPay: D128(r.basicPay),
      overtimePay: D128(r.overtimePay),
      allowances: D128(r.allowances),
      absencesDeduction: D128(r.absencesDeduction),
      lateDeduction: D128(r.lateDeduction),
      grossPay: D128(r.grossPay),
      sss: D128(r.sss),
      philhealth: D128(r.philhealth),
      pagibig: D128(r.pagibig),
      taxableIncome: D128(r.taxableIncome),
      withholdingTax: D128(r.withholdingTax),
      otherDeductions: D128(r.otherDeductions),
      totalDeductions: D128(r.totalDeductions),
      netPay: D128(r.netPay),
      employer: { sss: D128(r.employer.sss), philhealth: D128(r.employer.philhealth), pagibig: D128(r.employer.pagibig) },
      allowanceItems: allowances.map((x) => ({ label: x.name, amount: x.amount })),
      deductionItems: deductions.map((d) => ({ label: d.label, amount: D128(d.amount) })),
      _result: r,
    }
  })

  await PayrollLine.deleteMany({ periodId: period._id }, { session })
  await PayrollLine.insertMany(
    lines.map(({ _result, ...l }) => l),
    { session },
  )

  const results = lines.map((l) => l._result)
  period.headcount = lines.length
  period.gross = D128(sum(results.map((r) => r.grossPay)))
  period.deductions = D128(sum(results.map((r) => r.totalDeductions)))
  period.net = D128(sum(results.map((r) => r.netPay)))
  period.employerContributions = D128(sum(results.flatMap((r) => [r.employer.sss, r.employer.philhealth, r.employer.pagibig])))
  period.status = 'computed'
  period.computedAt = new Date()
  period.computedById = actor.userId ? new mongoose.Types.ObjectId(actor.userId) : undefined
  period.approvedBy = undefined
  period.approvedById = undefined
  await period.save({ session })
  return period
}

const transitions: Record<string, PeriodStatus[]> = {
  computed: ['review'],
  review: ['computed', 'approved'],
  approved: ['released'],
}

/** Move a period through review → approval → release, enforcing roles and maker–checker. */
export async function transitionPeriod(
  periodId: string,
  to: PeriodStatus,
  actor: { userId: string; name: string; role: Role },
  session: ClientSession,
) {
  const period = await PayrollPeriod.findById(periodId).session(session)
  if (!period) throw notFound('Payroll period')
  if (!transitions[period.status]?.includes(to)) throw conflict(`Cannot move payroll from ${period.status} to ${to}`)

  if (to === 'review' && !can(actor.role, 'payroll.process')) throw forbidden()
  if (to === 'computed' && !can(actor.role, 'payroll.process') && !can(actor.role, 'payroll.approve')) throw forbidden()
  if (to === 'approved') {
    if (!can(actor.role, 'payroll.approve')) throw forbidden()
    if (period.computedById?.equals(actor.userId)) throw forbidden('The person who computed this payroll cannot approve it')
    period.approvedBy = actor.name
    period.approvedById = new mongoose.Types.ObjectId(actor.userId)
  }
  if (to === 'released') {
    if (!can(actor.role, 'payroll.release')) throw forbidden()
    await releaseEffects(period._id, period.label, session)
    period.releasedAt = new Date()
  }

  period.status = to
  await period.save({ session })
  return period
}

/** On release: amortize loans and notify every employee that their payslip is ready. */
async function releaseEffects(periodId: mongoose.Types.ObjectId, label: string, session: ClientSession) {
  const lines = await PayrollLine.find({ periodId }).session(session).lean()
  if (!lines.length) throw badRequest('This payroll has no computed lines')

  const loans = await Adjustment.find({
    employeeId: { $in: lines.map((l) => l.employeeId) },
    kind: 'deduction',
    active: true,
    balance: { $ne: null },
  }).session(session)
  for (const loan of loans) {
    const line = lines.find((l) => l.employeeId.equals(loan.employeeId))
    const paid = line?.deductionItems.find((d) => d.label === loan.name)
    if (!paid) continue
    const remaining = Decimal.max(new Decimal(String(loan.balance)).minus(String(paid.amount)), 0)
    loan.balance = D128(remaining.toFixed(2))
    if (remaining.isZero()) loan.active = false
    await loan.save({ session })
  }

  await notify(
    lines.map((l) => l.employeeId),
    { kind: 'payslip', title: 'Your payslip is ready', body: `Payslip for ${label} has been released.`, link: '/app/payslips' },
    session,
  )
}
