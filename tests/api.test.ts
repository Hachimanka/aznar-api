import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { connectMemoryDb, disconnectDb } from '../src/db/index.js'
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
  let admin: string, finance: string, hr: string
  beforeAll(async () => {
    ;[admin, finance, hr] = await Promise.all([login('payroll@aznar.com', 'apay'), login('finance@aznar.com', 'apay'), login('hr@aznar.com', 'apay')])
  })
  const as = (token: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  })

  it('runs compute → review → approve → release with role checks and maker–checker', async () => {
    const periods = (await as(admin).get('/apay/periods')).body
    const open = periods.find((p: { status: string }) => p.status === 'draft')
    expect(open).toBeTruthy()

    // HR cannot compute
    expect((await as(hr).post(`/apay/periods/${open.id}/compute`)).status).toBe(403)

    const computed = await as(admin).post(`/apay/periods/${open.id}/compute`)
    expect(computed.status, JSON.stringify(computed.body)).toBe(200)
    expect(computed.body.status).toBe('computed')
    expect(computed.body.headcount).toBeGreaterThan(20)

    const lines = (await as(admin).get(`/apay/periods/${open.id}/lines`)).body
    expect(sum(lines.map((l: { netPay: string }) => l.netPay))).toBe(computed.body.net)

    // Cannot skip review
    expect((await as(finance).post(`/apay/periods/${open.id}/status`, { status: 'approved' })).status).toBe(409)

    expect((await as(admin).post(`/apay/periods/${open.id}/status`, { status: 'review' })).body.status).toBe('review')
    // Payroll Admin lacks approve permission
    expect((await as(admin).post(`/apay/periods/${open.id}/status`, { status: 'approved' })).status).toBe(403)

    const approved = await as(finance).post(`/apay/periods/${open.id}/status`, { status: 'approved' })
    expect(approved.body.status).toBe('approved')
    expect(approved.body.approvedBy).toBe('Jose Reyes')

    // Approved payroll is locked
    expect((await as(admin).post(`/apay/periods/${open.id}/compute`)).status).toBe(409)

    const released = await as(admin).post(`/apay/periods/${open.id}/status`, { status: 'released' })
    expect(released.body.status).toBe('released')

    // The employee now sees the new payslip and a notification in AZONE
    const leonard = await login('leonard.forrosuelo@aznar.com', 'azone')
    const slips = (await request(app).get('/azone/payslips').set('Authorization', `Bearer ${leonard}`)).body
    expect(slips[0].periodEnd).toBe(open.end)
    const notes = (await request(app).get('/azone/notifications').set('Authorization', `Bearer ${leonard}`)).body
    expect(notes[0].kind).toBe('payslip')

    expect((await as(admin).get('/apay/audit')).body[0].action).toBe('Released payroll')
  })

  it('amortizes loans on release', async () => {
    const loan = (await as(admin).get('/apay/adjustments')).body.find((a: { name: string }) => a.name === 'SSS Salary Loan')
    expect(loan.balance).toBe('13750.00')
  })

  it('blocks Finance from changing settings', async () => {
    const res = await request(app)
      .put('/apay/settings')
      .set('Authorization', `Bearer ${finance}`)
      .send({ companyName: 'X', graceMinutes: 5, roundLateTo: 1, requireTwoStepApproval: true, autoPublishToAzone: true })
    expect(res.status).toBe(403)
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
    expect((await as(admin).get('/apay/employees/not-an-id')).status).toBe(404)
    expect((await as(admin).post('/apay/adjustments', { employeeId: 'x' })).status).toBe(400)
  })
})
