import { describe, expect, it } from 'vitest'
import {
  computeCutoff,
  dailyRate,
  pagibigMonthly,
  philhealthMonthly,
  sssMonthly,
  sssMsc,
  sum,
  withholdingTaxSemiMonthly,
} from '../src/lib/payroll.js'

describe('rates', () => {
  it('derives daily rate from 261 working days', () => {
    expect(dailyRate('26100').toFixed(2)).toBe('1200.00')
  })
})

describe('SSS', () => {
  it('rounds compensation to the nearest ₱500 credit', () => {
    expect(sssMsc('20240').toFixed(0)).toBe('20000')
    expect(sssMsc('20250').toFixed(0)).toBe('20500')
  })
  it('clamps to the minimum and maximum credit', () => {
    expect(sssMsc('3000').toFixed(0)).toBe('5000')
    expect(sssMsc('80000').toFixed(0)).toBe('35000')
  })
  it('splits 5% employee / 10% employer', () => {
    expect(sssMonthly('50000')).toEqual({ employee: '1750.00', employer: '3500.00' })
  })
})

describe('PhilHealth', () => {
  it('charges 5% shared equally, within floor and ceiling', () => {
    expect(philhealthMonthly('50000')).toEqual({ employee: '1250.00', employer: '1250.00' })
    expect(philhealthMonthly('8000')).toEqual({ employee: '250.00', employer: '250.00' })
    expect(philhealthMonthly('150000')).toEqual({ employee: '2500.00', employer: '2500.00' })
  })
})

describe('Pag-IBIG', () => {
  it('caps the fund salary at ₱10,000', () => {
    expect(pagibigMonthly('50000')).toEqual({ employee: '200.00', employer: '200.00' })
    expect(pagibigMonthly('8000')).toEqual({ employee: '160.00', employer: '160.00' })
  })
})

describe('withholding tax (semi-monthly)', () => {
  it('is zero up to ₱10,417', () => {
    expect(withholdingTaxSemiMonthly('10417')).toBe('0.00')
  })
  it('applies bracket base plus excess rate', () => {
    expect(withholdingTaxSemiMonthly('16667')).toBe('937.50')
    expect(withholdingTaxSemiMonthly('20000')).toBe('1604.10')
    expect(withholdingTaxSemiMonthly('40000')).toBe('5937.45')
  })
})

describe('computeCutoff', () => {
  const base = {
    monthlyBasic: '50000.00',
    deMinimis: '1000.00',
    taxableAllowances: '1000.00',
    absentDays: 0,
    unpaidLeaveDays: 0,
    lateMinutes: 0,
    overtime: [],
    otherDeductions: [],
  }

  it('computes a clean cut-off', () => {
    const r = computeCutoff(base)
    expect(r.basicPay).toBe('25000.00')
    expect(r.grossPay).toBe('27000.00')
    expect(r.sss).toBe('875.00')
    expect(r.philhealth).toBe('625.00')
    expect(r.pagibig).toBe('100.00')
    // taxable = 27000 - 1000 de minimis - 1600 contributions = 24400
    expect(r.taxableIncome).toBe('24400.00')
    expect(r.withholdingTax).toBe('2484.10')
    expect(r.netPay).toBe('22915.90')
  })

  it('deducts absences and lates, and pays overtime', () => {
    const r = computeCutoff({ ...base, absentDays: 1, lateMinutes: 30, overtime: [{ kind: 'regular', hours: 2 }] })
    // daily = 50000*12/261 = 2298.85; hourly = 287.36
    expect(r.absencesDeduction).toBe('2298.85')
    expect(r.lateDeduction).toBe('143.68')
    expect(r.overtimePay).toBe('718.39')
  })

  it('keeps net = gross - deductions to the centavo', () => {
    const r = computeCutoff({ ...base, otherDeductions: [{ label: 'SSS Loan', amount: '1250.50' }] })
    expect(sum([r.netPay, r.totalDeductions])).toBe(r.grossPay)
  })
})
