import { Decimal } from 'decimal.js'

/** Money is numeric(12,2) in Postgres and travels as 2-decimal strings ("24500.00"). */
export function money(v: unknown): string {
  if (v === null || v === undefined || v === '') return '0.00'
  return new Decimal(String(v)).toFixed(2)
}
