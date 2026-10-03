import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import bcrypt from 'bcryptjs'
import { connectMemoryDb, db, disconnectDb } from '../src/db/index.js'
import { users } from '../src/db/schema.js'
import { signToken } from '../src/middleware/auth.js'
import { seedDatabase } from '../src/seed/seed.js'
import { sum } from '../src/lib/payroll.js'

const PASSWORD = 'Test@12345'
const app = createApp()

async function login(email: string, appName: 'azone' | 'apay') {
  const res = await request(app).post('/auth/login').send({ email, password: PASSWORD, app: appName })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.token as string
}

beforeAll(async () => {
  // Real Postgres (PGlite) with the same migrations Supabase gets
  await connectMemoryDb()
  await seedDatabase({ password: PASSWORD })
})

afterAll(async () => {
  await disconnectDb()
})

describe('auth', () => {
  it('rejects a wrong password with a generic message', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'payroll@aznar.com', password: 'nope', app: 'apay' })
    expect(res.status).toBe(401)
    expect(res.body.message).toBe('Incorrect email or password')
  })

  it('does not let employees into APAY', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'leonard.forrosuelo@aznar.com', password: PASSWORD, app: 'apay' })
    expect(res.status).toBe(403)
  })

  it('ignores the role the client asks for', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'hr@aznar.com', password: PASSWORD, app: 'apay', role: 'payroll_admin' })
    expect(res.body.user.role).toBe('hr')
  })

  it('does not accept an AZONE token on APAY routes', async () => {
    const token = await login('leonard.forrosuelo@aznar.com', 'azone')
    const res = await request(app).get('/apay/employees').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('requires a token', async () => {
    expect((await request(app).get('/azone/me')).status).toBe(401)
  })
})

describe('AZONE', () => {
  let token: string
  beforeAll(async () => {
    token = await login('leonard.forrosuelo@aznar.com', 'azone')
  })
  const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`)

  it('returns the profile without salary and with masked government IDs', async () => {
    const res = await get('/azone/me')
    expect(res.body.fullName).toBe('Leonard Forrosuelo')
    expect(res.body.monthlyBasic).toBeUndefined()
    expect(res.body.govIds.sss).toContain('•')
  })

  it('lists released payslips whose net equals gross minus deductions', async () => {
    const res = await get('/azone/payslips')
    expect(res.body).toHaveLength(6)
    for (const p of res.body) expect(sum([p.net, p.totalDeductions])).toBe(p.gross)
  })

  it('cannot read another employee’s payslip', async () => {
    const other = await login('maria.santos@aznar.com', 'azone')
    const mine = (await get('/azone/payslips')).body[0].id
    const res = await request(app).get(`/azone/payslips/${mine}`).set('Authorization', `Bearer ${other}`)
    expect(res.status).toBe(404)
  })

  it('validates leave filing', async () => {
    const res = await request(app)
      .post('/azone/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'vacation', startDate: '2026-12-10', endDate: '2026-12-01', reason: 'Trip' })
    expect(res.status).toBe(400)
  })

  it('returns leave balances and only published announcements', async () => {
    expect((await get('/azone/leaves/balances')).body.map((b: { type: string }) => b.type)).toEqual(['vacation', 'sick', 'emergency', 'birthday'])
    expect((await get('/azone/announcements')).body.every((a: { title: string }) => a.title !== '13th Month Pay Schedule')).toBe(true)
  })

  it('returns a DTR month and a today record', async () => {
    const today = (await get('/azone/attendance/today')).body
    expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const month = (await get(`/azone/attendance?month=${today.date.slice(0, 7)}`)).body
    expect(month.at(-1).date).toBe(today.date)
  })
})

describe('APAY payroll cycle', () => {
  let hr: string
  beforeAll(async () => {
    hr = await login('hr@aznar.com', 'apay')
  })
  const as = (token: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  })

  it('is HR-only: other staff accounts can’t sign in, and their old tokens are refused', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    for (const role of ['payroll_admin', 'finance', 'management'] as const) {
      const [u] = await db().insert(users).values({ email: `${role}@aznar.com`, passwordHash, name: role, role }).returning()
      const res = await request(app).post('/auth/login').send({ email: u.email, password: PASSWORD, app: 'apay' })
      expect(res.status).toBe(403)
      expect(res.body.message).toBe('APAY is for the HR department only')
      const oldToken = signToken({ userId: u.id, name: u.name, role, app: 'apay' })
      expect((await as(oldToken).get('/apay/periods')).status).toBe(403)
    }
  })

  it('lets HR edit/upload cut-off attendance that payroll then uses', async () => {
    const open = (await as(hr).get('/apay/periods')).body.find((p: { status: string }) => p.status === 'draft')
    const put = (body: object) => request(app).put(`/apay/periods/${open.id}/attendance`).set('Authorization', `Bearer ${hr}`).send(body)
    const rows = (await as(hr).get(`/apay/periods/${open.id}/attendance`)).body
    const leo = rows.find((r: { name: string }) => r.name === 'Leonard Forrosuelo')
    expect(leo.source).toBe('dtr')
    const edit = {
      employeeId: leo.employeeId,
      daysPresent: leo.workingDays - 2,
      absentDays: 2,
      lateMinutes: 30,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
    }

    // Day counts must add up to the working days
    expect((await put({ source: 'manual', rows: [{ ...edit, absentDays: 3 }] })).status).toBe(400)

    // Editing a computed payroll sends it back to draft so stale numbers can't be approved
    await as(hr).post(`/apay/periods/${open.id}/compute`)
    const saved = await put({ source: 'manual', rows: [edit] })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.find((r: { employeeId: string }) => r.employeeId === leo.employeeId)).toMatchObject({ absentDays: 2, lateMinutes: 30, source: 'manual' })
    expect((await as(hr).get(`/apay/periods/${open.id}`)).body.status).toBe('draft')
    expect((await as(hr).get(`/apay/periods/${open.id}/lines`)).body).toHaveLength(0)

    await as(hr).post(`/apay/periods/${open.id}/compute`)
    const line = (await as(hr).get(`/apay/periods/${open.id}/lines`)).body.find((l: { employeeId: string }) => l.employeeId === leo.employeeId)
    expect(line.absencesDeduction).toBe('4597.70') // 2 days × (50,000 × 12 ÷ 261)

    // Reset goes back to the DTR numbers
    const reset = await request(app).delete(`/apay/periods/${open.id}/attendance/${leo.employeeId}`).set('Authorization', `Bearer ${hr}`)
    expect(reset.status).toBe(200)
    expect(reset.body.find((r: { employeeId: string }) => r.employeeId === leo.employeeId)).toMatchObject({ absentDays: leo.absentDays, source: 'dtr' })
  })

  it('lets HR run compute → review → approve → release on its own', async () => {
    const periods = (await as(hr).get('/apay/periods')).body
    const open = periods.find((p: { status: string }) => p.status === 'draft')
    expect(open).toBeTruthy()

    const computed = await as(hr).post(`/apay/periods/${open.id}/compute`)
    expect(computed.status, JSON.stringify(computed.body)).toBe(200)
    expect(computed.body.status).toBe('computed')
    expect(computed.body.headcount).toBeGreaterThan(20)

    const lines = (await as(hr).get(`/apay/periods/${open.id}/lines`)).body
    expect(sum(lines.map((l: { netPay: string }) => l.netPay))).toBe(computed.body.net)

    // Steps still can't be skipped
    expect((await as(hr).post(`/apay/periods/${open.id}/status`, { status: 'approved' })).status).toBe(409)
    expect((await as(hr).post(`/apay/periods/${open.id}/status`, { status: 'review' })).body.status).toBe('review')

    // The same HR account that computed it can approve it
    const approved = await as(hr).post(`/apay/periods/${open.id}/status`, { status: 'approved' })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.status).toBe('approved')
    expect(approved.body.approvedBy).toBe('Ana Cruz')

    // Approved payroll is locked
    expect((await as(hr).post(`/apay/periods/${open.id}/compute`)).status).toBe(409)
    const lockedEdit = await request(app)
      .put(`/apay/periods/${open.id}/attendance`)
      .set('Authorization', `Bearer ${hr}`)
      .send({ source: 'manual', rows: [{ employeeId: lines[0].employeeId, daysPresent: 0, absentDays: 0, lateMinutes: 0, paidLeaveDays: 0, unpaidLeaveDays: 0 }] })
    expect(lockedEdit.status).toBe(409)

    const released = await as(hr).post(`/apay/periods/${open.id}/status`, { status: 'released' })
    expect(released.body.status).toBe('released')

    // The employee now sees the new payslip and a notification in AZONE
    const leonard = await login('leonard.forrosuelo@aznar.com', 'azone')
    const slips = (await request(app).get('/azone/payslips').set('Authorization', `Bearer ${leonard}`)).body
    expect(slips[0].periodEnd).toBe(open.end)
    const notes = (await request(app).get('/azone/notifications').set('Authorization', `Bearer ${leonard}`)).body
    expect(notes[0].kind).toBe('payslip')

    expect((await as(hr).get('/apay/audit')).body[0].action).toBe('Released payroll')
  })

  it('amortizes loans on release', async () => {
    const loan = (await as(hr).get('/apay/adjustments')).body.find((a: { name: string }) => a.name === 'SSS Salary Loan')
    expect(loan.balance).toBe('13750.00')
  })

  it('lets HR change settings', async () => {
    const res = await request(app)
      .put('/apay/settings')
      .set('Authorization', `Bearer ${hr}`)
      .send({ companyName: 'Aznar', graceMinutes: 5, roundLateTo: 1, requireTwoStepApproval: true, autoPublishToAzone: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('publishing an announcement notifies employees', async () => {
    const res = await as(hr).post('/apay/announcements', {
      category: 'HR',
      title: 'Test announcement',
      body: 'Hello everyone, this is a test.',
      status: 'published',
      audience: 'all',
    })
    expect(res.status).toBe(201)
    const leonard = await login('leonard.forrosuelo@aznar.com', 'azone')
    const notes = (await request(app).get('/azone/notifications').set('Authorization', `Bearer ${leonard}`)).body
    expect(notes[0].body).toBe('Test announcement')
  })

  it('rejects invalid ids and bodies cleanly', async () => {
    expect((await as(hr).get('/apay/employees/not-an-id')).status).toBe(404)
    expect((await as(hr).post('/apay/adjustments', { employeeId: 'x' })).status).toBe(400)
  })
})
