import { and, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { db, type Exec, type Tx } from '../db/index.js'
import { adjustments, employees, payrollLines, payrollPeriods, type periodStatus } from '../db/schema.js'
import { computeCutoff, sum } from '../lib/payroll.js'
import { cutoffFor, manilaDate, periodLabel } from '../lib/dates.js'
import { money } from '../lib/money.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js'
import { can, type Role } from '../lib/permissions.js'
import { cutoffAttendance } from './attendance.js'
import { notify } from './core.js'

export type PeriodStatus = (typeof periodStatus)[number]

/** Make sure the cut-off containing today exists, so there's always an open period to process. */
export async function ensureCurrentPeriod(today = manilaDate(), q: Exec = db()) {
  const { start, end } = cutoffFor(today)
  await q
    .insert(payrollPeriods)
    .values({ startDate: start, endDate: end, label: periodLabel(start, end), payDate: end })
    .onConflictDoNothing({ target: payrollPeriods.endDate })
}

async function lockPeriod(q: Exec, periodId: string) {
  // FOR UPDATE: two people can't compute or approve the same cut-off at the same moment
  const [p] = await q.select().from(payrollPeriods).where(eq(payrollPeriods.id, periodId)).for('update')
  if (!p) throw notFound('Payroll period')
  return p
}

/** Run the engine for every active employee and replace the period's payroll lines. Run inside a transaction. */
export async function computePeriod(periodId: string, actor: { userId?: string }, q: Exec) {
  const period = await lockPeriod(q, periodId)
  if (period.status !== 'draft' && period.status !== 'computed') throw conflict(`A ${period.status} payroll can no longer be recomputed`)

  const staff = await q
    .select()
    .from(employees)
    .where(and(ne(employees.status, 'resigned'), lte(employees.hireDate, period.endDate)))
  const ids = staff.map((e) => e.id)
  const [summary, adj] = await Promise.all([
    cutoffAttendance(period, ids, q),
    ids.length
      ? q
          .select()
          .from(adjustments)
          .where(and(inArray(adjustments.employeeId, ids), eq(adjustments.active, true)))
      : Promise.resolve([]),
  ])

  const lines = staff.map((e) => {
    const a = summary.get(e.id)!
    const mine = adj.filter((x) => x.employeeId === e.id)
    const allowanceRows = mine.filter((x) => x.kind === 'allowance')
    // A loan never deducts more than its remaining balance
    const deductionItems = mine
      .filter((x) => x.kind === 'deduction')
      .map((x) => ({ label: x.name, amount: money(x.balance != null ? Decimal.min(x.amount, x.balance) : x.amount) }))
      .filter((d) => Number(d.amount) > 0)

    const r = computeCutoff({
      monthlyBasic: money(e.monthlyBasic),
      deMinimis: sum(allowanceRows.filter((x) => x.category === 'de_minimis').map((x) => money(x.amount))),
      taxableAllowances: sum(allowanceRows.filter((x) => x.category !== 'de_minimis').map((x) => money(x.amount))),
      absentDays: a.absentDays,
      unpaidLeaveDays: a.unpaidLeaveDays,
      lateMinutes: a.lateMinutes,
      overtime: a.overtime,
      otherDeductions: deductionItems,
    })

    return {
      result: r,
      row: {
        periodId: period.id,
        employeeId: e.id,
        employeeNo: e.employeeNo,
        name: `${e.firstName} ${e.lastName}`,
        department: e.department,
        monthlyBasic: money(e.monthlyBasic),
        basicPay: r.basicPay,
        overtimePay: r.overtimePay,
        allowances: r.allowances,
        absencesDeduction: r.absencesDeduction,
        lateDeduction: r.lateDeduction,
        grossPay: r.grossPay,
        sss: r.sss,
        philhealth: r.philhealth,
        pagibig: r.pagibig,
        taxableIncome: r.taxableIncome,
        withholdingTax: r.withholdingTax,
        otherDeductions: r.otherDeductions,
        totalDeductions: r.totalDeductions,
        netPay: r.netPay,
        employerSss: r.employer.sss,
        employerPhilhealth: r.employer.philhealth,
        employerPagibig: r.employer.pagibig,
        allowanceItems: allowanceRows.map((x) => ({ label: x.name, amount: money(x.amount) })),
        deductionItems,
      },
    }
  })

  await q.delete(payrollLines).where(eq(payrollLines.periodId, period.id))
  if (lines.length) await q.insert(payrollLines).values(lines.map((l) => l.row))

  const results = lines.map((l) => l.result)
  const [updated] = await q
    .update(payrollPeriods)
    .set({
      headcount: lines.length,
      gross: sum(results.map((r) => r.grossPay)),
      deductions: sum(results.map((r) => r.totalDeductions)),
      net: sum(results.map((r) => r.netPay)),
      employerContributions: sum(results.flatMap((r) => [r.employer.sss, r.employer.philhealth, r.employer.pagibig])),
      status: 'computed',
      computedAt: new Date(),
      computedById: actor.userId ?? null,
      approvedBy: null,
      approvedById: null,
    })
    .where(eq(payrollPeriods.id, period.id))
    .returning()
  return updated
}

/**
 * Lock a cut-off before its attendance changes. Only draft/computed payrolls accept edits; a computed one
 * goes back to draft (lines cleared) so it can't move to review with numbers from the old attendance.
 */
export async function reopenForAttendance(periodId: string, tx: Tx) {
  const period = await lockPeriod(tx, periodId)
  if (period.status !== 'draft' && period.status !== 'computed') throw conflict(`Attendance of a ${period.status} payroll can no longer be changed`)
  if (period.status === 'computed') {
    await tx.delete(payrollLines).where(eq(payrollLines.periodId, period.id))
    await tx
      .update(payrollPeriods)
      .set({ status: 'draft', headcount: 0, gross: '0', deductions: '0', net: '0', employerContributions: '0', computedAt: null, computedById: null })
      .where(eq(payrollPeriods.id, period.id))
  }
  return period
}

const transitions: Partial<Record<PeriodStatus, PeriodStatus[]>> = {
  computed: ['review'],
  review: ['computed', 'approved'],
  approved: ['released'],
}

/** Move a period through review → approval → release, enforcing permissions (HR runs every step). Run inside a transaction. */
export async function transitionPeriod(periodId: string, to: PeriodStatus, actor: { userId: string; name: string; role: Role }, tx: Tx) {
  const period = await lockPeriod(tx, periodId)
  if (!transitions[period.status]?.includes(to)) throw conflict(`Cannot move payroll from ${period.status} to ${to}`)

  const patch: Partial<typeof payrollPeriods.$inferInsert> = { status: to }
  if (to === 'review' && !can(actor.role, 'payroll.process')) throw forbidden()
  if (to === 'computed' && !can(actor.role, 'payroll.process') && !can(actor.role, 'payroll.approve')) throw forbidden()
  if (to === 'approved') {
    if (!can(actor.role, 'payroll.approve')) throw forbidden()
    patch.approvedBy = actor.name
    patch.approvedById = actor.userId
  }
  if (to === 'released') {
    if (!can(actor.role, 'payroll.release')) throw forbidden()
    await releaseEffects(period.id, period.label, tx)
    patch.releasedAt = new Date()
  }

  const [updated] = await tx.update(payrollPeriods).set(patch).where(eq(payrollPeriods.id, period.id)).returning()
  return updated
}

/** On release: amortize loans and notify every employee that their payslip is ready. */
async function releaseEffects(periodId: string, label: string, tx: Tx) {
  const lines = await tx.select().from(payrollLines).where(eq(payrollLines.periodId, periodId))
  if (!lines.length) throw badRequest('This payroll has no computed lines')

  const loans = await tx
    .select()
    .from(adjustments)
    .where(
      and(
        inArray(
          adjustments.employeeId,
          lines.map((l) => l.employeeId),
        ),
        eq(adjustments.kind, 'deduction'),
        eq(adjustments.active, true),
        isNotNull(adjustments.balance),
      ),
    )
  for (const loan of loans) {
    const paid = lines.find((l) => l.employeeId === loan.employeeId)?.deductionItems.find((d) => d.label === loan.name)
    if (!paid) continue
    const remaining = Decimal.max(new Decimal(loan.balance!).minus(paid.amount), 0)
    await tx
      .update(adjustments)
      .set({ balance: remaining.toFixed(2), active: !remaining.isZero() })
      .where(eq(adjustments.id, loan.id))
  }

  await notify(
    lines.map((l) => l.employeeId),
    { kind: 'payslip', title: 'Your payslip is ready', body: `Payslip for ${label} has been released.`, link: '/app/payslips' },
    tx,
  )
}
