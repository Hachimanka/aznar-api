import mongoose from 'mongoose'
import { Decimal } from 'decimal.js'

/** Money is stored as Decimal128 in MongoDB and exposed as 2-decimal strings in JSON. */

export const D128 = (v: string | number) => mongoose.Types.Decimal128.fromString(new Decimal(v).toFixed(2))

export function money(v: unknown): string {
  if (v === null || v === undefined) return '0.00'
  return new Decimal(String(v)).toFixed(2)
}
