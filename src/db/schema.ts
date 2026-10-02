import { sql } from 'drizzle-orm'
import { boolean, date, index, integer, jsonb, numeric, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Supabase (PostgreSQL) schema.
 * - Money is numeric(12,2); the driver returns it as a string like "24500.00" (never a float).
 * - Calendar days are `date` columns returned as 'yyyy-MM-dd'; instants are timestamptz.
 * - Row Level Security is ON with no policies: Supabase's public Data API (anon/authenticated keys)
 *   can't read or write these tables. Only aznar-api, connecting as the database owner, can.
 */

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const money = (name: string) => numeric(name, { precision: 12, scale: 2 })
const day = (name: string) => date(name, { mode: 'string' })
const instant = (name: string) => timestamp(name, { withTimezone: true })
const employeeRef = () =>
  uuid('employee_id')
    .notNull()
    .references(() => employees.id, { onDelete: 'cascade' })

export const approvalStatus = ['pending', 'approved', 'rejected'] as const

/* -------------------------------- Employees -------------------------------- */

export const employees = pgTable(
  'employees',
  {
    id: id(),
    employeeNo: text('employee_no').notNull().unique(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    position: text('position').notNull(),
    department: text('department').notNull(),
    employmentType: text('employment_type', { enum: ['Regular', 'Probationary', 'Contractual'] })
      .notNull()
      .default('Regular'),
    status: text('status', { enum: ['active', 'on_leave', 'resigned'] })
      .notNull()
      .default('active'),
    monthlyBasic: money('monthly_basic').notNull(),
    hireDate: day('hire_date').notNull(),
    birthday: day('birthday'),
    phone: text('phone').notNull().default(''),
    address: text('address').notNull().default(''),
    manager: text('manager').notNull().default(''),
    workSchedule: text('work_schedule').notNull().default('Mon–Fri · 8:00 AM – 5:00 PM'),
    taxStatus: text('tax_status', { enum: ['S', 'ME', 'S1', 'ME1', 'ME2'] })
      .notNull()
      .default('S'),
    bankName: text('bank_name').notNull().default(''),
    bankAccount: text('bank_account').notNull().default(''),
    sss: text('sss').notNull().default(''),
    philhealth: text('philhealth').notNull().default(''),
    pagibig: text('pagibig').notNull().default(''),
    tin: text('tin').notNull().default(''),
    emergencyName: text('emergency_name').notNull().default(''),
    emergencyRelation: text('emergency_relation').notNull().default(''),
    emergencyPhone: text('emergency_phone').notNull().default(''),
    vacationCredits: integer('vacation_credits').notNull().default(15),
    sickCredits: integer('sick_credits').notNull().default(15),
    emergencyCredits: integer('emergency_credits').notNull().default(3),
    birthdayCredits: integer('birthday_credits').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('employees_department_idx').on(t.department), index('employees_status_idx').on(t.status)],
).enableRLS()

/* ----------------------------------- Users ----------------------------------- */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  title: text('title').notNull().default(''),
  role: text('role', { enum: ['employee', 'hr', 'payroll_admin', 'finance', 'management'] }).notNull(),
  /** Staff can also be employees — this links them to their own AZONE record */
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  lastLoginAt: instant('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS()

/* ------------------------------- Time & leave ------------------------------- */

export const attendance = pgTable(
  'attendance',
  {
    id: id(),
    employeeId: employeeRef(),
    date: day('date').notNull(),
    timeIn: instant('time_in'),
    breakOut: instant('break_out'),
    breakIn: instant('break_in'),
    timeOut: instant('time_out'),
    source: text('source', { enum: ['azone', 'biometric', 'manual'] })
      .notNull()
      .default('azone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('attendance_employee_date_uq').on(t.employeeId, t.date), index('attendance_date_idx').on(t.date)],
).enableRLS()

export const leaves = pgTable(
  'leaves',
  {
    id: id(),
    employeeId: employeeRef(),
    type: text('type', { enum: ['vacation', 'sick', 'emergency', 'birthday', 'unpaid'] }).notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    days: integer('days').notNull(),
    reason: text('reason').notNull().default(''),
    paid: boolean('paid').notNull(),
    status: text('status', { enum: approvalStatus }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [index('leaves_employee_idx').on(t.employeeId), index('leaves_range_idx').on(t.startDate, t.endDate)],
).enableRLS()

export const employeeRequests = pgTable(
  'employee_requests',
  {
    id: id(),
    employeeId: employeeRef(),
    kind: text('kind', { enum: ['coe', 'schedule_change', 'overtime', 'reimbursement', 'other'] }).notNull(),
    title: text('title').notNull(),
    details: text('details').notNull(),
    status: text('status', { enum: approvalStatus }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [index('requests_employee_idx').on(t.employeeId)],
).enableRLS()

export const overtime = pgTable(
  'overtime',
  {
    id: id(),
    employeeId: employeeRef(),
    date: day('date').notNull(),
    hours: real('hours').notNull(),
    kind: text('kind', { enum: ['regular', 'restDay', 'specialHoliday', 'regularHoliday'] })
      .notNull()
      .default('regular'),
    reason: text('reason').notNull().default(''),
    status: text('status', { enum: approvalStatus }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [index('overtime_employee_date_idx').on(t.employeeId, t.date)],
).enableRLS()

/* ---------------------------------- Payroll ---------------------------------- */

export const adjustments = pgTable(
  'adjustments',
  {
    id: id(),
    employeeId: employeeRef(),
    kind: text('kind', { enum: ['allowance', 'deduction'] }).notNull(),
    category: text('category', { enum: ['de_minimis', 'taxable', 'loan', 'other'] }).notNull(),
    name: text('name').notNull(),
    amount: money('amount').notNull(),
    balance: money('balance'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('adjustments_employee_idx').on(t.employeeId)],
).enableRLS()

export const periodStatus = ['draft', 'computed', 'review', 'approved', 'released'] as const

export const payrollPeriods = pgTable('payroll_periods', {
  id: id(),
  startDate: day('start_date').notNull(),
  endDate: day('end_date').notNull().unique(),
  label: text('label').notNull(),
  payDate: day('pay_date').notNull(),
  status: text('status', { enum: periodStatus }).notNull().default('draft'),
  headcount: integer('headcount').notNull().default(0),
  gross: money('gross').notNull().default('0'),
  deductions: money('deductions').notNull().default('0'),
  net: money('net').notNull().default('0'),
  employerContributions: money('employer_contributions').notNull().default('0'),
  computedAt: instant('computed_at'),
  computedById: uuid('computed_by_id').references(() => users.id),
  approvedBy: text('approved_by'),
  approvedById: uuid('approved_by_id').references(() => users.id),
  releasedAt: instant('released_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS()

export type LineItem = { label: string; amount: string }

/** One employee's computed pay for one cut-off. Frozen once the period is approved. */
export const payrollLines = pgTable(
  'payroll_lines',
  {
    id: id(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => payrollPeriods.id, { onDelete: 'cascade' }),
    employeeId: employeeRef(),
    // Snapshot of the employee at computation time — later edits never change a payslip
    employeeNo: text('employee_no').notNull(),
    name: text('name').notNull(),
    department: text('department').notNull(),
    monthlyBasic: money('monthly_basic').notNull(),
    basicPay: money('basic_pay').notNull(),
    overtimePay: money('overtime_pay').notNull(),
    allowances: money('allowances').notNull(),
    absencesDeduction: money('absences_deduction').notNull(),
    lateDeduction: money('late_deduction').notNull(),
    grossPay: money('gross_pay').notNull(),
    sss: money('sss').notNull(),
    philhealth: money('philhealth').notNull(),
    pagibig: money('pagibig').notNull(),
    taxableIncome: money('taxable_income').notNull(),
    withholdingTax: money('withholding_tax').notNull(),
    otherDeductions: money('other_deductions').notNull(),
    totalDeductions: money('total_deductions').notNull(),
    netPay: money('net_pay').notNull(),
    employerSss: money('employer_sss').notNull(),
    employerPhilhealth: money('employer_philhealth').notNull(),
    employerPagibig: money('employer_pagibig').notNull(),
    allowanceItems: jsonb('allowance_items')
      .$type<LineItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    deductionItems: jsonb('deduction_items')
      .$type<LineItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payroll_lines_period_employee_uq').on(t.periodId, t.employeeId), index('payroll_lines_employee_idx').on(t.employeeId)],
).enableRLS()

/* -------------------------- Communication & admin -------------------------- */

export const announcements = pgTable(
  'announcements',
  {
    id: id(),
    category: text('category', { enum: ['HR', 'General', 'Policy', 'Event'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    author: text('author').notNull(),
    status: text('status', { enum: ['published', 'draft'] })
      .notNull()
      .default('draft'),
    audience: text('audience').notNull().default('all'),
    pinned: boolean('pinned').notNull().default(false),
    publishedAt: instant('published_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('announcements_status_idx').on(t.status, t.publishedAt)],
).enableRLS()

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    employeeId: employeeRef(),
    kind: text('kind', { enum: ['payslip', 'leave', 'announcement', 'request', 'attendance'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    read: boolean('read').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_employee_idx').on(t.employeeId, t.createdAt)],
).enableRLS()

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
}).enableRLS()

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actor: text('actor').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
).enableRLS()

export type Employee = typeof employees.$inferSelect
export type PayrollPeriod = typeof payrollPeriods.$inferSelect
export type PayrollLine = typeof payrollLines.$inferSelect
