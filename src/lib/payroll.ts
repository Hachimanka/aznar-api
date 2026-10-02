import { Decimal } from 'decimal.js'

/**
 * APAY payroll engine — semi-monthly cut-offs.
 * All money math uses Decimal and returns 2-decimal strings. Never use JS floats for pesos.
 *
 * Statutory rates below reflect 2025 schedules. HR must confirm against the latest
 * SSS / PhilHealth / Pag-IBIG / BIR circulars before each year (see Settings → Government tables).
 */

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })

export type Money = string
const D = (v: Decimal.Value) => new Decimal(v)
const money = (v: Decimal) => v.toDecimalPlaces(2).toFixed(2)

export const WORKING_DAYS_PER_YEAR = 261
export const HOURS_PER_DAY = 8

export const OT_MULTIPLIERS = {
  regular: '1.25',
  restDay: '1.30',
  specialHoliday: '1.30',
  regularHoliday: '2.00',
} as const

export type OvertimeKind = keyof typeof OT_MULTIPLIERS

/* ------------------------------ Statutory tables ------------------------------ */

export const SSS = { rate: '0.15', employeeRate: '0.05', employerRate: '0.10', mscMin: '5000', mscMax: '35000', mscStep: '500' }
export const PHILHEALTH = { rate: '0.05', employeeShare: '0.5', floor: '10000', ceiling: '100000' }
export const PAGIBIG = { employeeRate: '0.02', employerRate: '0.02', maxFundSalary: '10000' }

/** BIR withholding tax table (TRAIN, 2023 onwards) — semi-monthly. */
export const BIR_SEMI_MONTHLY = [
  { over: '0', base: '0', rate: '0' },
  { over: '10417', base: '0', rate: '0.15' },
  { over: '16667', base: '937.50', rate: '0.20' },
  { over: '33333', base: '4270.70', rate: '0.25' },
  { over: '83333', base: '16770.70', rate: '0.30' },
  { over: '333333', base: '91770.70', rate: '0.35' },
]

/* --------------------------------- Rates --------------------------------- */

export function dailyRate(monthlyBasic: Money) {
  return D(monthlyBasic).times(12).div(WORKING_DAYS_PER_YEAR)
}

export function hourlyRate(monthlyBasic: Money) {
  return dailyRate(monthlyBasic).div(HOURS_PER_DAY)
}

/* --------------------------- Government contributions --------------------------- */

/** Monthly Salary Credit: monthly compensation rounded to the nearest ₱500 bracket, clamped. */
export function sssMsc(monthlyCompensation: Money) {
  const step = D(SSS.mscStep)
  const msc = D(monthlyCompensation).div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step)
  return Decimal.min(Decimal.max(msc, SSS.mscMin), SSS.mscMax)
}

/** Monthly contributions — split evenly across the two cut-offs. */
export function sssMonthly(monthlyCompensation: Money) {
  const msc = sssMsc(monthlyCompensation)
  return { employee: money(msc.times(SSS.employeeRate)), employer: money(msc.times(SSS.employerRate)) }
}

export function philhealthMonthly(monthlyBasic: Money) {
  const base = Decimal.min(Decimal.max(D(monthlyBasic), PHILHEALTH.floor), PHILHEALTH.ceiling)
  const premium = base.times(PHILHEALTH.rate)
  const employee = premium.times(PHILHEALTH.employeeShare)
  return { employee: money(employee), employer: money(premium.minus(employee)) }
}

export function pagibigMonthly(monthlyBasic: Money) {
  const base = Decimal.min(D(monthlyBasic), PAGIBIG.maxFundSalary)
  return { employee: money(base.times(PAGIBIG.employeeRate)), employer: money(base.times(PAGIBIG.employerRate)) }
}

export function withholdingTaxSemiMonthly(taxableIncome: Money) {
  const income = D(taxableIncome)
  if (income.lte(0)) return '0.00'
  const bracket = [...BIR_SEMI_MONTHLY].reverse().find((b) => income.gt(b.over))!
  return money(D(bracket.base).plus(income.minus(bracket.over).times(bracket.rate)))
}

/* ------------------------------- Cut-off payslip ------------------------------- */

export type CutoffInput = {
  monthlyBasic: Money
  /** Non-taxable de minimis (rice, laundry…) for this cut-off */
  deMinimis: Money
  /** Taxable allowances for this cut-off */
  taxableAllowances: Money
  absentDays: number
  unpaidLeaveDays: number
  lateMinutes: number
  overtime: { kind: OvertimeKind; hours: number }[]
  /** Loan amortizations and other post-tax deductions for this cut-off */
  otherDeductions: { label: string; amount: Money }[]
}

export type CutoffResult = {
  basicPay: Money
  overtimePay: Money
  allowances: Money
  absencesDeduction: Money
  lateDeduction: Money
  grossPay: Money
  sss: Money
  philhealth: Money
  pagibig: Money
  taxableIncome: Money
  withholdingTax: Money
  otherDeductions: Money
  totalDeductions: Money
  netPay: Money
  employer: { sss: Money; philhealth: Money; pagibig: Money }
}

export function computeCutoff(input: CutoffInput): CutoffResult {
  const basic = D(input.monthlyBasic).div(2)
  const daily = dailyRate(input.monthlyBasic)
  const hourly = daily.div(HOURS_PER_DAY)

  const absences = daily.times(input.absentDays + input.unpaidLeaveDays)
  const late = hourly.div(60).times(input.lateMinutes)
  const overtime = input.overtime.reduce((sum, ot) => sum.plus(hourly.times(OT_MULTIPLIERS[ot.kind]).times(ot.hours)), D(0))
  const allowances = D(input.deMinimis).plus(input.taxableAllowances)

  const gross = basic.minus(absences).minus(late).plus(overtime).plus(allowances)

  // Contributions are computed monthly and split in half per cut-off
  const half = (v: Money) => D(v).div(2)
  const sss = sssMonthly(input.monthlyBasic)
  const ph = philhealthMonthly(input.monthlyBasic)
  const hdmf = pagibigMonthly(input.monthlyBasic)
  const contributions = half(sss.employee).plus(half(ph.employee)).plus(half(hdmf.employee))

  const taxable = Decimal.max(gross.minus(input.deMinimis).minus(contributions), 0)
  const tax = withholdingTaxSemiMonthly(money(taxable))
  const other = input.otherDeductions.reduce((s, d) => s.plus(d.amount), D(0))

  const totalDeductions = contributions.plus(tax).plus(other)

  return {
    basicPay: money(basic),
    overtimePay: money(overtime),
    allowances: money(allowances),
    absencesDeduction: money(absences),
    lateDeduction: money(late),
    grossPay: money(gross),
    sss: money(half(sss.employee)),
    philhealth: money(half(ph.employee)),
    pagibig: money(half(hdmf.employee)),
    taxableIncome: money(taxable),
    withholdingTax: tax,
    otherDeductions: money(other),
    totalDeductions: money(totalDeductions),
    netPay: money(gross.minus(totalDeductions)),
    employer: { sss: money(half(sss.employer)), philhealth: money(half(ph.employer)), pagibig: money(half(hdmf.employer)) },
  }
}

/** Sum a list of decimal strings safely. */
export function sum(values: Money[]) {
  return money(values.reduce((s, v) => s.plus(v), D(0)))
}
