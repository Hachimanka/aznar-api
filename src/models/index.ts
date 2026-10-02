import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose'

const { Decimal128 } = Schema.Types
const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model, required: true as const, index: true })
const opts = { timestamps: true }

/* ---------------------------------- Users ---------------------------------- */

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true },
    title: { type: String, default: '' },
    role: { type: String, enum: ['employee', 'hr', 'payroll_admin', 'finance', 'management'], required: true },
    /** Staff can also be employees — this links them to their own AZONE record */
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  opts,
)

/* -------------------------------- Employees -------------------------------- */

const employeeSchema = new Schema(
  {
    employeeNo: { type: String, required: true, unique: true, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    position: { type: String, required: true },
    department: { type: String, required: true, index: true },
    employmentType: { type: String, enum: ['Regular', 'Probationary', 'Contractual'], default: 'Regular' },
    status: { type: String, enum: ['active', 'on_leave', 'resigned'], default: 'active', index: true },
    monthlyBasic: { type: Decimal128, required: true },
    hireDate: { type: String, required: true },
    birthday: { type: String, default: '' },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    manager: { type: String, default: '' },
    workSchedule: { type: String, default: 'Mon–Fri · 8:00 AM – 5:00 PM' },
    taxStatus: { type: String, enum: ['S', 'ME', 'S1', 'ME1', 'ME2'], default: 'S' },
    bank: { name: { type: String, default: '' }, account: { type: String, default: '' } },
    govIds: {
      sss: { type: String, default: '' },
      philhealth: { type: String, default: '' },
      pagibig: { type: String, default: '' },
      tin: { type: String, default: '' },
    },
    emergencyContact: { name: { type: String, default: '' }, relation: { type: String, default: '' }, phone: { type: String, default: '' } },
    leaveCredits: {
      vacation: { type: Number, default: 15 },
      sick: { type: Number, default: 15 },
      emergency: { type: Number, default: 3 },
      birthday: { type: Number, default: 1 },
    },
  },
  opts,
)

/* ------------------------------- Time & leave ------------------------------- */

const attendanceSchema = new Schema(
  {
    employeeId: ref('Employee'),
    date: { type: String, required: true },
    timeIn: { type: Date, default: null },
    breakOut: { type: Date, default: null },
    breakIn: { type: Date, default: null },
    timeOut: { type: Date, default: null },
    source: { type: String, enum: ['azone', 'biometric', 'manual'], default: 'azone' },
  },
  opts,
)
attendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true })

const approval = { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true }

const leaveSchema = new Schema(
  {
    employeeId: ref('Employee'),
    type: { type: String, enum: ['vacation', 'sick', 'emergency', 'birthday', 'unpaid'], required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    days: { type: Number, required: true },
    reason: { type: String, default: '' },
    paid: { type: Boolean, required: true },
    status: approval,
    decidedBy: String,
  },
  opts,
)

const requestSchema = new Schema(
  {
    employeeId: ref('Employee'),
    kind: { type: String, enum: ['coe', 'schedule_change', 'overtime', 'reimbursement', 'other'], required: true },
    title: { type: String, required: true },
    details: { type: String, required: true },
    status: approval,
    decidedBy: String,
  },
  opts,
)

const overtimeSchema = new Schema(
  {
    employeeId: ref('Employee'),
    date: { type: String, required: true },
    hours: { type: Number, required: true, min: 0.5, max: 16 },
    kind: { type: String, enum: ['regular', 'restDay', 'specialHoliday', 'regularHoliday'], default: 'regular' },
    reason: { type: String, default: '' },
    status: approval,
    decidedBy: String,
  },
  opts,
)

/* --------------------------------- Payroll --------------------------------- */

const adjustmentSchema = new Schema(
  {
    employeeId: ref('Employee'),
    kind: { type: String, enum: ['allowance', 'deduction'], required: true },
    category: { type: String, enum: ['de_minimis', 'taxable', 'loan', 'other'], required: true },
    name: { type: String, required: true },
    amount: { type: Decimal128, required: true },
    balance: { type: Decimal128 },
    active: { type: Boolean, default: true },
  },
  opts,
)

const periodSchema = new Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    payDate: { type: String, required: true },
    status: { type: String, enum: ['draft', 'computed', 'review', 'approved', 'released'], default: 'draft', index: true },
    headcount: { type: Number, default: 0 },
    gross: { type: Decimal128, default: () => mongoose.Types.Decimal128.fromString('0.00') },
    deductions: { type: Decimal128, default: () => mongoose.Types.Decimal128.fromString('0.00') },
    net: { type: Decimal128, default: () => mongoose.Types.Decimal128.fromString('0.00') },
    employerContributions: { type: Decimal128, default: () => mongoose.Types.Decimal128.fromString('0.00') },
    computedAt: Date,
    computedById: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: String,
    approvedById: { type: Schema.Types.ObjectId, ref: 'User' },
    releasedAt: Date,
  },
  opts,
)

const moneyLine = { type: Decimal128, required: true }

/** One employee's computed pay for one cut-off. Frozen once the period is approved. */
const lineSchema = new Schema(
  {
    periodId: ref('PayrollPeriod'),
    employeeId: ref('Employee'),
    // Snapshot of the employee at computation time — later edits never change a payslip
    employeeNo: String,
    name: String,
    department: String,
    monthlyBasic: moneyLine,
    basicPay: moneyLine,
    overtimePay: moneyLine,
    allowances: moneyLine,
    absencesDeduction: moneyLine,
    lateDeduction: moneyLine,
    grossPay: moneyLine,
    sss: moneyLine,
    philhealth: moneyLine,
    pagibig: moneyLine,
    taxableIncome: moneyLine,
    withholdingTax: moneyLine,
    otherDeductions: moneyLine,
    totalDeductions: moneyLine,
    netPay: moneyLine,
    employer: { sss: moneyLine, philhealth: moneyLine, pagibig: moneyLine },
    allowanceItems: [{ _id: false, label: String, amount: Decimal128 }],
    deductionItems: [{ _id: false, label: String, amount: Decimal128 }],
  },
  opts,
)
lineSchema.index({ periodId: 1, employeeId: 1 }, { unique: true })

/* ------------------------- Communication & admin ------------------------- */

const announcementSchema = new Schema(
  {
    category: { type: String, enum: ['HR', 'General', 'Policy', 'Event'], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    author: { type: String, required: true },
    status: { type: String, enum: ['published', 'draft'], default: 'draft', index: true },
    audience: { type: String, default: 'all' },
    pinned: { type: Boolean, default: false },
    publishedAt: { type: Date, default: () => new Date() },
  },
  opts,
)

const notificationSchema = new Schema(
  {
    employeeId: ref('Employee'),
    kind: { type: String, enum: ['payslip', 'leave', 'announcement', 'request', 'attendance'], required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: String,
    read: { type: Boolean, default: false },
  },
  opts,
)

const settingSchema = new Schema({ key: { type: String, required: true, unique: true }, value: { type: Schema.Types.Mixed, required: true } }, opts)

const auditSchema = new Schema(
  {
    actor: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    target: { type: String, default: '' },
  },
  opts,
)

export const User = mongoose.model('User', userSchema)
export const Employee = mongoose.model('Employee', employeeSchema)
export const Attendance = mongoose.model('Attendance', attendanceSchema)
export const Leave = mongoose.model('Leave', leaveSchema)
export const EmployeeRequest = mongoose.model('EmployeeRequest', requestSchema)
export const Overtime = mongoose.model('Overtime', overtimeSchema)
export const Adjustment = mongoose.model('Adjustment', adjustmentSchema)
export const PayrollPeriod = mongoose.model('PayrollPeriod', periodSchema)
export const PayrollLine = mongoose.model('PayrollLine', lineSchema)
export const Announcement = mongoose.model('Announcement', announcementSchema)
export const Notification = mongoose.model('Notification', notificationSchema)
export const Setting = mongoose.model('Setting', settingSchema)
export const Audit = mongoose.model('Audit', auditSchema)

export type EmployeeDoc = InferSchemaType<typeof employeeSchema> & { _id: Types.ObjectId }
export type PeriodDoc = InferSchemaType<typeof periodSchema> & { _id: Types.ObjectId }
export type LineDoc = InferSchemaType<typeof lineSchema> & { _id: Types.ObjectId }
