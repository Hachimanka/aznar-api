import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import {
  Adjustment,
  Announcement,
  Attendance,
  Audit,
  Employee,
  EmployeeRequest,
  Leave,
  Notification,
  Overtime,
  PayrollLine,
  PayrollPeriod,
  Setting,
  User,
} from '../models/index.js'
import { addDays, cutoffFor, eachDay, isWeekend, manilaDate, manilaInstant, manilaMinutes, periodLabel } from '../lib/dates.js'
import { D128 } from '../lib/money.js'
import { computePeriod, ensureCurrentPeriod } from '../services/payroll.js'
import { defaultPayrollSettings, type CompanyInfo } from '../services/core.js'

/** Deterministic pseudo-random numbers so every seed produces the same demo. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const people: [string, string, string, string, number, string][] = [
  ['Leonard', 'Forrosuelo', 'IT Department', 'Software Engineer', 50000, '2021-03-01'],
  ['Maria', 'Santos', 'IT Department', 'IT Manager', 95000, '2016-06-01'],
  ['Jose', 'Reyes', 'Finance', 'Finance Manager', 88000, '2015-02-01'],
  ['Ana', 'Cruz', 'HR Department', 'HR Manager', 82000, '2017-01-01'],
  ['Mark', 'Bautista', 'Operations', 'Operations Supervisor', 45000, '2019-08-01'],
  ['Kristine', 'Villanueva', 'Finance', 'Payroll Specialist', 38000, '2022-04-01'],
  ['Paolo', 'Garcia', 'Sales & Marketing', 'Account Executive', 32000, '2020-10-01'],
  ['Jasmine', 'Mendoza', 'Customer Service', 'CS Team Lead', 30000, '2022-01-01'],
  ['Rafael', 'Ramos', 'Operations', 'Logistics Coordinator', 26000, '2023-05-01'],
  ['Camille', 'Aquino', 'HR Department', 'Recruitment Specialist', 34000, '2020-07-01'],
  ['Miguel', 'Torres', 'IT Department', 'Systems Administrator', 48000, '2018-11-01'],
  ['Patricia', 'Flores', 'Sales & Marketing', 'Marketing Associate', 28000, '2026-06-01'],
  ['Joshua', 'Navarro', 'Operations', 'Warehouse Staff', 18500, '2024-03-01'],
  ['Bea', 'Castillo', 'Customer Service', 'CS Representative', 21000, '2023-09-01'],
  ['Carlo', 'Domingo', 'Finance', 'Accountant', 42000, '2019-01-01'],
  ['Nicole', 'Lim', 'Sales & Marketing', 'Sales Manager', 78000, '2016-03-01'],
  ['Gabriel', 'Tan', 'IT Department', 'QA Engineer', 40000, '2021-09-01'],
  ['Andrea', 'Del Rosario', 'Customer Service', 'CS Representative', 21000, '2024-02-01'],
  ['Ramon', 'Fernandez', 'Operations', 'Driver', 19000, '2020-05-01'],
  ['Sofia', 'Gonzales', 'HR Department', 'HR Associate', 27000, '2022-08-01'],
  ['Luis', 'Pascual', 'Operations', 'Warehouse Staff', 18500, '2025-01-01'],
  ['Hannah', 'Rivera', 'Finance', 'Billing Associate', 25000, '2023-02-01'],
  ['Daniel', 'Ocampo', 'Sales & Marketing', 'Account Executive', 32000, '2021-04-01'],
  ['Erika', 'Salazar', 'IT Department', 'UI/UX Designer', 45000, '2022-11-01'],
]

const company: CompanyInfo = {
  name: 'Aznar',
  about:
    'Aznar is a Cebu-based group of companies serving communities across the Visayas. We believe great service starts with taking care of our people.',
  mission: 'To build lasting value for our customers, communities and employees through excellence and integrity.',
  vision: 'To be the most trusted and people-centered company in the region.',
  values: [
    { title: 'Integrity', description: 'We do what is right, even when no one is watching.' },
    { title: 'Excellence', description: 'We hold ourselves to high standards in everything we do.' },
    { title: 'Malasakit', description: 'We genuinely care for our colleagues and customers.' },
    { title: 'Teamwork', description: 'We win together, across departments and companies.' },
  ],
  offices: [
    { name: 'Head Office', address: 'Aznar Building, Cebu Business Park, Cebu City', phone: '(032) 555 0100' },
    { name: 'Manila Office', address: 'Ortigas Center, Pasig City', phone: '(02) 8555 0100' },
  ],
  hotlines: [
    { label: 'HR Helpdesk', value: 'hr@aznar.com · local 120' },
    { label: 'Payroll Concerns', value: 'payroll@aznar.com · local 135' },
    { label: 'IT Support', value: 'it@aznar.com · local 200' },
  ],
  holidays: [
    { date: '2026-08-21', name: 'Ninoy Aquino Day', type: 'Special' },
    { date: '2026-08-31', name: 'National Heroes Day', type: 'Regular' },
    { date: '2026-11-01', name: "All Saints' Day", type: 'Special' },
    { date: '2026-11-30', name: 'Bonifacio Day', type: 'Regular' },
    { date: '2026-12-08', name: 'Feast of the Immaculate Conception', type: 'Special' },
    { date: '2026-12-24', name: 'Christmas Eve', type: 'Special' },
    { date: '2026-12-25', name: 'Christmas Day', type: 'Regular' },
    { date: '2026-12-30', name: 'Rizal Day', type: 'Regular' },
    { date: '2026-12-31', name: 'Last Day of the Year', type: 'Special' },
  ],
}

const staff = [
  { email: 'payroll@aznar.com', role: 'payroll_admin', person: 'Kristine Villanueva', title: 'Payroll Specialist' },
  { email: 'hr@aznar.com', role: 'hr', person: 'Ana Cruz', title: 'HR Manager' },
  { email: 'finance@aznar.com', role: 'finance', person: 'Jose Reyes', title: 'Finance Manager' },
  { email: 'management@aznar.com', role: 'management', person: 'Nicole Lim', title: 'Sales Manager' },
] as const

/**
 * Wipe and fill the database with a realistic demo: 24 employees, accounts, ~3 months of
 * attendance, leaves, overtime, adjustments and six released cut-offs computed by the real engine.
 */
export async function seedDatabase({ password, today = manilaDate() }: { password: string; today?: string }) {
  const rand = rng(20261002)
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]
  const holidays = new Set(company.holidays.map((h) => h.date))
  const workday = (d: string) => !isWeekend(d) && !holidays.has(d)

  await Promise.all(
    [
      Adjustment,
      Announcement,
      Attendance,
      Audit,
      Employee,
      EmployeeRequest,
      Leave,
      Notification,
      Overtime,
      PayrollLine,
      PayrollPeriod,
      Setting,
      User,
    ].map((m) => (m as mongoose.Model<unknown>).deleteMany({})),
  )
  await Setting.create([
    { key: 'payroll', value: defaultPayrollSettings },
    { key: 'company', value: company },
  ])

  /* Employees & accounts */
  const employees = await Employee.insertMany(
    people.map(([firstName, lastName, department, position, salary, hireDate], i) => ({
      employeeNo: i === 0 ? 'AZN-2021-0148' : `AZN-${hireDate.slice(0, 4)}-${String(100 + i * 7).padStart(4, '0')}`,
      firstName,
      lastName,
      email: `${firstName}.${lastName}`.toLowerCase().replace(/\s/g, '') + '@aznar.com',
      position,
      department,
      employmentType: i === 11 ? 'Probationary' : i === 20 ? 'Contractual' : 'Regular',
      status: i === 19 ? 'on_leave' : 'active',
      monthlyBasic: D128(salary),
      hireDate,
      birthday: `199${i % 10}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      phone: `+63 917 555 ${String(100 + i).padStart(4, '0')}`,
      address: pick(['Banilad, Cebu City', 'Mandaue City, Cebu', 'Lahug, Cebu City', 'Talisay City, Cebu', 'Mabolo, Cebu City']),
      manager:
        department === 'IT Department'
          ? 'Maria Santos'
          : department === 'Finance'
            ? 'Jose Reyes'
            : department === 'HR Department'
              ? 'Ana Cruz'
              : 'Nicole Lim',
      taxStatus: pick(['S', 'ME', 'S1', 'ME1', 'ME2'] as const),
      bank: { name: pick(['BDO', 'BPI', 'Metrobank', 'UnionBank'] as const), account: String(1000000000 + Math.floor(rand() * 8999999999)) },
      govIds: {
        sss: `34-${1000000 + Math.floor(rand() * 8999999)}-${Math.floor(rand() * 9)}`,
        philhealth: `12-${100000000 + Math.floor(rand() * 899999999)}-${Math.floor(rand() * 9)}`,
        pagibig: `1211-${1000 + Math.floor(rand() * 8999)}-${1000 + Math.floor(rand() * 8999)}`,
        tin: `${100 + Math.floor(rand() * 899)}-${100 + Math.floor(rand() * 899)}-${100 + Math.floor(rand() * 899)}-000`,
      },
      emergencyContact: {
        name: `${pick(['Ana', 'Jose', 'Maria', 'Pedro', 'Rosa'])} ${lastName}`,
        relation: pick(['Spouse', 'Parent', 'Sibling']),
        phone: `+63 918 555 ${String(200 + i).padStart(4, '0')}`,
      },
    })),
  )
  const byName = new Map(employees.map((e) => [`${e.firstName} ${e.lastName}`, e]))
  const leonard = employees[0]

  const passwordHash = await bcrypt.hash(password, 10)
  await User.insertMany([
    ...employees.map((e) => ({
      email: e.email,
      passwordHash,
      name: `${e.firstName} ${e.lastName}`,
      title: e.position,
      role: 'employee',
      employeeId: e._id,
    })),
    ...staff.map((s) => ({ email: s.email, passwordHash, name: s.person, title: s.title, role: s.role, employeeId: byName.get(s.person)!._id })),
  ])

  /* Leaves (relative to today, landing on workdays) */
  const nextWorkday = (d: string, dir = 1) => {
    while (!workday(d)) d = addDays(d, dir)
    return d
  }
  const span = (start: string, n: number) => {
    const days: string[] = []
    for (let d = start; days.length < n; d = addDays(d, 1)) if (workday(d)) days.push(d)
    return { start: days[0], end: days.at(-1)!, days: n }
  }
  const leaves = [
    {
      who: 'Leonard Forrosuelo',
      type: 'vacation',
      ...span(nextWorkday(addDays(today, 12)), 2),
      reason: 'Family trip to Bohol',
      paid: true,
      status: 'pending',
    },
    { who: 'Leonard Forrosuelo', type: 'sick', ...span(nextWorkday(addDays(today, -20), -1), 1), reason: 'Flu', paid: true, status: 'approved' },
    {
      who: 'Leonard Forrosuelo',
      type: 'vacation',
      ...span(nextWorkday(addDays(today, -48), -1), 3),
      reason: 'Personal errands',
      paid: true,
      status: 'approved',
    },
    {
      who: 'Sofia Gonzales',
      type: 'unpaid',
      ...span(nextWorkday(addDays(today, -1), -1), 8),
      reason: 'Extended personal leave',
      paid: false,
      status: 'approved',
    },
    { who: 'Bea Castillo', type: 'sick', ...span(nextWorkday(addDays(today, -3), -1), 1), reason: 'Fever', paid: true, status: 'approved' },
    {
      who: 'Patricia Flores',
      type: 'vacation',
      ...span(nextWorkday(addDays(today, -15), -1), 3),
      reason: 'Vacation',
      paid: true,
      status: 'approved',
    },
    {
      who: 'Ramon Fernandez',
      type: 'emergency',
      ...span(nextWorkday(addDays(today, -20), -1), 1),
      reason: 'Family emergency',
      paid: true,
      status: 'approved',
    },
    {
      who: 'Luis Pascual',
      type: 'unpaid',
      ...span(nextWorkday(addDays(today, -25), -1), 2),
      reason: 'Personal matters',
      paid: false,
      status: 'approved',
    },
    { who: 'Camille Aquino', type: 'vacation', ...span(nextWorkday(addDays(today, 5)), 1), reason: 'Errands', paid: true, status: 'pending' },
  ]
  await Leave.insertMany(leaves.map(({ who, ...l }) => ({ ...l, employeeId: byName.get(who)!._id })))
  const onLeave = (id: mongoose.Types.ObjectId, day: string) =>
    leaves.some((l) => byName.get(l.who)!._id.equals(id) && l.status === 'approved' && l.start <= day && day <= l.end)

  /* Attendance from the start of the 7th cut-off back, up to today */
  let first = cutoffFor(today)
  for (let i = 0; i < 6; i++) first = cutoffFor(addDays(first.start, -1))
  const nowMinutes = manilaMinutes(new Date())
  const attendance: Record<string, unknown>[] = []
  for (const e of employees) {
    for (const day of eachDay(first.start, today)) {
      if (!workday(day) || day < e.hireDate || onLeave(e._id, day)) continue
      const roll = rand()
      if (day === today) {
        // Today: punches only up to the current time
        if (nowMinutes < 8 * 60 + 3) continue
        const inMin = e._id.equals(leonard._id) ? 3 : Math.floor(rand() * 6)
        attendance.push({
          employeeId: e._id,
          date: day,
          timeIn: manilaInstant(day, 8, inMin),
          breakOut: nowMinutes >= 12 * 60 ? manilaInstant(day, 12, 0) : null,
          breakIn: nowMinutes >= 13 * 60 ? manilaInstant(day, 13, 0) : null,
          source: 'azone',
        })
        continue
      }
      if (roll < 0.03) continue // absent
      const late = roll > 0.9
      attendance.push({
        employeeId: e._id,
        date: day,
        timeIn: manilaInstant(day, 8, late ? 12 + Math.floor(rand() * 30) : Math.floor(rand() * 5)),
        breakOut: manilaInstant(day, 12, 0),
        breakIn: manilaInstant(day, 13, 0),
        timeOut: manilaInstant(day, 17, Math.floor(rand() * 40)),
        source: pick(['azone', 'biometric'] as const),
      })
    }
  }
  await Attendance.insertMany(attendance)

  /* Overtime: approved history (paid in released cut-offs) plus a few pending */
  const recentWorkdays = eachDay(first.start, addDays(today, -1)).filter(workday)
  const otPeople = ['Leonard Forrosuelo', 'Miguel Torres', 'Mark Bautista', 'Rafael Ramos', 'Jasmine Mendoza', 'Kristine Villanueva']
  const overtime = recentWorkdays
    .filter(() => rand() < 0.35)
    .map((date) => ({
      employeeId: byName.get(pick(otPeople))!._id,
      date,
      hours: 1 + Math.floor(rand() * 3),
      kind: 'regular',
      reason: pick(['Month-end closing', 'Deployment support', 'Inventory count', 'Ticket backlog', 'Late deliveries']),
      status: 'approved',
    }))
  overtime.push(
    {
      employeeId: leonard._id,
      date: nextWorkday(addDays(today, -1), -1),
      hours: 3,
      kind: 'regular',
      reason: 'Production deployment support',
      status: 'pending',
    },
    {
      employeeId: byName.get('Miguel Torres')!._id,
      date: nextWorkday(addDays(today, -2), -1),
      hours: 4,
      kind: 'regular',
      reason: 'Server migration',
      status: 'pending',
    },
    {
      employeeId: byName.get('Mark Bautista')!._id,
      date: nextWorkday(addDays(today, -1), -1),
      hours: 2,
      kind: 'regular',
      reason: 'Inventory count',
      status: 'pending',
    },
  )
  await Overtime.insertMany(overtime)

  /* Allowances, loans and other deductions */
  await Adjustment.insertMany([
    ...employees.map((e) => ({ employeeId: e._id, kind: 'allowance', category: 'de_minimis', name: 'Rice Subsidy', amount: D128(1000) })),
    ...employees
      .filter((_, i) => i % 3 === 0)
      .map((e) => ({ employeeId: e._id, kind: 'allowance', category: 'taxable', name: 'Transportation Allowance', amount: D128(1000) })),
    {
      employeeId: byName.get('Mark Bautista')!._id,
      kind: 'deduction',
      category: 'loan',
      name: 'SSS Salary Loan',
      amount: D128(1250),
      balance: D128(15000),
    },
    {
      employeeId: byName.get('Joshua Navarro')!._id,
      kind: 'deduction',
      category: 'loan',
      name: 'Pag-IBIG MPL',
      amount: D128(850),
      balance: D128(9350),
    },
    {
      employeeId: byName.get('Rafael Ramos')!._id,
      kind: 'deduction',
      category: 'loan',
      name: 'Company Cash Advance',
      amount: D128(2000),
      balance: D128(4000),
    },
    { employeeId: byName.get('Paolo Garcia')!._id, kind: 'deduction', category: 'other', name: 'HMO Dependent', amount: D128(650) },
  ])

  /* Requests */
  await EmployeeRequest.insertMany([
    { employeeId: leonard._id, kind: 'coe', title: 'Certificate of Employment', details: 'For bank loan application', status: 'pending' },
    {
      employeeId: leonard._id,
      kind: 'schedule_change',
      title: 'Schedule Change',
      details: 'Shift to 9 AM – 6 PM for one week',
      status: 'rejected',
      decidedBy: 'Maria Santos',
    },
  ])

  /* Six released cut-offs, computed by the real engine */
  const finance = await User.findOne({ role: 'finance' })
  const payroll = await User.findOne({ role: 'payroll_admin' })
  let cut = cutoffFor(addDays(cutoffFor(today).start, -1))
  const history: { start: string; end: string }[] = []
  for (let i = 0; i < 6; i++) {
    history.unshift(cut)
    cut = cutoffFor(addDays(cut.start, -1))
  }
  for (const c of history) {
    const p = await PayrollPeriod.create({ ...c, label: periodLabel(c.start, c.end), payDate: c.end })
    await computePeriod(String(p._id), { userId: String(payroll!._id) })
    const releasedAt = manilaInstant(c.end, 15, 0)
    await PayrollPeriod.updateOne({ _id: p._id }, { $set: { status: 'released', approvedBy: finance!.name, approvedById: finance!._id, releasedAt } })
    await Audit.insertMany([
      {
        actor: payroll!.name,
        actorId: payroll!._id,
        action: 'Computed payroll',
        target: p.label,
        createdAt: manilaInstant(addDays(c.end, -2), 10, 0),
      },
      {
        actor: finance!.name,
        actorId: finance!._id,
        action: 'Approved payroll',
        target: p.label,
        createdAt: manilaInstant(addDays(c.end, -1), 14, 0),
      },
      { actor: payroll!.name, actorId: payroll!._id, action: 'Released payroll', target: p.label, createdAt: releasedAt },
    ])
  }
  await ensureCurrentPeriod(today)

  /* Announcements & notifications */
  const ago = (days: number) => manilaInstant(addDays(today, -days), 9, 0)
  const anns = await Announcement.insertMany([
    {
      category: 'HR',
      title: 'Company Holiday Schedule',
      body: 'Please be informed that the company holiday schedule for the remainder of the year has been released.\n\nOffices will be closed on All Saints’ Day, Bonifacio Day, Christmas Eve, Christmas Day, Rizal Day and New Year’s Eve. Holiday pay is computed automatically by APAY.',
      author: 'HR Department',
      status: 'published',
      pinned: true,
      publishedAt: ago(1),
    },
    {
      category: 'General',
      title: 'System Maintenance',
      body: 'The system will be undergoing maintenance this Saturday from 10:00 PM to 2:00 AM.\n\nAZONE and APAY may be briefly unavailable. Biometric punches will sync afterwards.',
      author: 'IT Department',
      status: 'published',
      publishedAt: ago(4),
    },
    {
      category: 'Policy',
      title: 'Updated Leave Policy',
      body: 'Effective next month, the company will be implementing updates to the leave policy.\n\n• Vacation leave must be filed at least 5 working days in advance.\n• Up to 5 unused vacation days can be carried over.\n• Sick leave longer than 2 days needs a medical certificate.',
      author: 'HR Department',
      status: 'published',
      publishedAt: ago(7),
    },
    {
      category: 'Event',
      title: 'Aznar Family Day 2026',
      body: 'Join us for a day of games, food and fun with your family at the company grounds.\n\nRegistration is open until the end of the month.',
      author: 'Employee Engagement',
      status: 'published',
      publishedAt: ago(12),
    },
    {
      category: 'General',
      title: '13th Month Pay Schedule',
      body: 'The 13th month pay will be released together with the December 1–15 payroll.',
      author: 'Payroll',
      status: 'draft',
      publishedAt: ago(0),
    },
  ])
  const lastLabel = periodLabel(history.at(-1)!.start, history.at(-1)!.end)
  await Notification.insertMany(
    employees.flatMap((e) => [
      {
        employeeId: e._id,
        kind: 'payslip',
        title: 'Your payslip is ready',
        body: `Payslip for ${lastLabel} has been released.`,
        link: '/app/payslips',
        createdAt: manilaInstant(history.at(-1)!.end, 15, 0),
      },
      {
        employeeId: e._id,
        kind: 'announcement',
        title: 'New announcement from HR',
        body: 'Company Holiday Schedule',
        link: `/app/announcements/${anns[0]._id}`,
        createdAt: ago(1),
      },
    ]),
  )

  return { employees: employees.length, users: employees.length + staff.length, attendance: attendance.length, periods: history.length + 1 }
}
