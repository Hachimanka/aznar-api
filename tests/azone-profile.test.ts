import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { connectMemoryDb, db, disconnectDb } from '../src/db/index.js'
import { notifications } from '../src/db/schema.js'
import { seedDatabase } from '../src/seed/seed.js'

const PASSWORD = 'Test@12345'
const app = createApp()
let token = ''
let employeeId = ''

// Smallest valid images: real magic bytes, not just a data-URL label
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const azone = () => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  put: (url: string, body: object) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
})

beforeAll(async () => {
  await connectMemoryDb()
  await seedDatabase({ password: PASSWORD })
  const res = await request(app).post('/auth/login').send({ email: 'leonard.forrosuelo@aznar.com', password: PASSWORD, app: 'azone' })
  token = res.body.token
  employeeId = res.body.employee.id
})

afterAll(async () => {
  await disconnectDb()
})

describe('profile picture', () => {
  it('starts with no picture', async () => {
    expect((await azone().get('/azone/me')).body.avatarUrl).toBeNull()
  })

  it('uploads, returns it on /me and at login, and replaces it', async () => {
    const res = await azone().put('/azone/me/avatar', { dataUrl: PNG })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.avatarUrl).toBe(PNG)
    expect((await azone().get('/azone/me')).body.avatarUrl).toBe(PNG)

    const login = await request(app).post('/auth/login').send({ email: 'leonard.forrosuelo@aznar.com', password: PASSWORD, app: 'azone' })
    expect(login.body.employee.avatarUrl).toBe(PNG)

    expect((await azone().put('/azone/me/avatar', { dataUrl: PNG })).status).toBe(200) // upsert, no duplicate-key error
  })

  it('rejects non-images, SVG, mislabelled bytes and oversized uploads', async () => {
    expect((await azone().put('/azone/me/avatar', { dataUrl: 'hello' })).status).toBe(400)
    expect((await azone().put('/azone/me/avatar', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })).status).toBe(400)
    // PNG bytes labelled as JPEG
    expect((await azone().put('/azone/me/avatar', { dataUrl: PNG.replace('image/png', 'image/jpeg') })).status).toBe(400)
    expect((await azone().put('/azone/me/avatar', { dataUrl: `data:image/png;base64,${'A'.repeat(95_000)}` })).status).not.toBe(200)
  })

  it('removes the picture', async () => {
    const res = await azone().del('/azone/me/avatar')
    expect(res.status).toBe(200)
    expect(res.body.avatarUrl).toBeNull()
    expect((await azone().get('/azone/me')).body.avatarUrl).toBeNull()
  })

  it('requires sign-in', async () => {
    expect((await request(app).put('/azone/me/avatar').send({ dataUrl: PNG })).status).toBe(401)
  })
})

describe('notification retention', () => {
  it('deletes notifications older than 30 days when the list is loaded', async () => {
    const day = 864e5
    await db()
      .insert(notifications)
      .values([
        { employeeId, kind: 'announcement', title: 'Old news', createdAt: new Date(Date.now() - 31 * day) },
        { employeeId, kind: 'announcement', title: 'Recent news', createdAt: new Date(Date.now() - 29 * day) },
      ])

    const titles = (await azone().get('/azone/notifications')).body.map((n: { title: string }) => n.title)
    expect(titles).toContain('Recent news')
    expect(titles).not.toContain('Old news')

    const left = await db().select().from(notifications).where(eq(notifications.title, 'Old news'))
    expect(left).toHaveLength(0)
  })
})
